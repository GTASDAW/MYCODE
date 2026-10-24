import {spawn} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createServer,request as proxyRequest} from 'node:http';
import {createReadStream} from 'node:fs';
import {mkdir,open,readFile,realpath,stat,writeFile} from 'node:fs/promises';
import {dirname,extname,join,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {crc32,deflateSync} from 'node:zlib';
import mysql from 'mysql2/promise';
import {chromium,devices,expect} from '@playwright/test';
import {createBackup,restoreBackup,snapshotDatabase,secureRuntimeDirectory} from './database-backup.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const digest=value=>createHash('sha256').update(value).digest('hex');
class DrillError extends Error {}
function check(value,message) {if(!value) throw new DrillError(message);}
function childEnvironment(extra={}) {
  return {...Object.fromEntries(Object.entries(process.env).filter(([key])=>
    !/^(SPRING_|SERVER_|MANAGEMENT_|APP_|AMAP_|DB_|DEMO_|AUTH_RATE_LIMIT_|SESSION_|MYSQL_|PORT$|JAVA_TOOL_OPTIONS$|JDK_JAVA_OPTIONS$|_JAVA_OPTIONS$)/i.test(key))),...extra};
}
function connection(config) {
  return mysql.createConnection({host:config.host,port:config.port,database:config.database,user:config.user,
    password:config.password,timezone:'Z',dateStrings:true,supportBigNumbers:true,bigNumberStrings:true,decimalNumbers:false,jsonStrings:true,connectTimeout:5000});
}
async function fullSnapshot(config) {const db=await connection(config);try {return await snapshotDatabase(db);} finally {await db.end();}}
async function freePort(port) {
  const server=createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  await new Promise(resolve=>server.close(resolve));
}
async function startChild(command,args,environment,logFile,children) {
  const file=await open(logFile,'wx',0o600);
  const child=spawn(command,args,{cwd:root,env:environment,windowsHide:true,stdio:['ignore',file.fd,file.fd]});
  const exited=new Promise(resolve=>{child.once('error',()=>resolve(-1));child.once('exit',code=>resolve(code));});
  const owned={child,exited,file};children.push(owned);
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(new Error('无法启动演练专用子进程')));});
  return owned;
}
async function waitHealthy(origin,owned) {
  const end=Date.now()+120000;
  while(Date.now()<end) {
    check(owned.child.exitCode===null&&owned.child.signalCode===null,'演练服务在就绪前退出');
    try {const result=await fetch(`${origin}/api/health`,{signal:AbortSignal.timeout(2000)});if(result.ok&&(await result.json()).status==='UP') return;} catch { /* bounded readiness only */ }
    await wait(500);
  }
  throw new Error('演练服务未在时限内就绪');
}

class Api {
  constructor(origin) {this.origin=origin;this.cookies=new Map();}
  async call(path,{method='GET',data,form,multipart,status=200}={}) {
    const headers={};
    if(!['GET','HEAD'].includes(method)) {
      const csrf=await this.call('/api/auth/csrf');headers[csrf.headerName]=csrf.token;
    }
    headers.Cookie=[...this.cookies].map(([key,value])=>`${key}=${value}`).join(';');
    let body;
    if(data!==undefined) {headers['Content-Type']='application/json';body=JSON.stringify(data);}
    if(form) {headers['Content-Type']='application/x-www-form-urlencoded';body=new URLSearchParams(form);}
    if(multipart) body=multipart;
    const response=await fetch(this.origin+path,{method,headers,body,redirect:'error',signal:AbortSignal.timeout(20000)});
    for(const cookie of response.headers.getSetCookie()) {const [key,value]=cookie.split(';')[0].split('=');this.cookies.set(key,value);}
    check(response.status===status,`恢复演练接口校验失败（HTTP ${response.status}）`);
    if(response.headers.get('Content-Type')?.startsWith('image/jpeg')) {
      if(new URL(path,this.origin).pathname==='/api/me/avatar') {
        check(response.headers.get('Cache-Control')==='no-store'&&response.headers.get('X-Content-Type-Options')==='nosniff','恢复头像必须禁止缓存并禁止 MIME 嗅探');
      }
      return Buffer.from(await response.arrayBuffer());
    }
    if(response.headers.get('Content-Type')?.startsWith('text/csv')) return response.text();
    return response.status===204?null:response.json();
  }
  login(username,password) {return this.call('/api/auth/login',{method:'POST',form:{username,password}});}
}

function pngFixture() {
  const chunk=(type,data)=>{const name=Buffer.from(type),length=Buffer.alloc(4),checksum=Buffer.alloc(4);
    length.writeUInt32BE(data.length);checksum.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([length,name,data,checksum]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(48);header.writeUInt32BE(27,4);header[8]=8;header[9]=2;
  const rows=Buffer.alloc((48*3+1)*27);
  for(let y=0;y<27;y++) for(let x=0;x<48;x++) {const offset=y*(48*3+1)+1+x*3;rows[offset]=40+x*3;rows[offset+1]=100+y*4;rows[offset+2]=220;}
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
function jpegDimensions(bytes) {
  check(bytes[0]===255&&bytes[1]===216,'头像样本必须是 JPEG');
  for(let position=2;position+8<bytes.length;) {
    check(bytes[position]===255,'头像 JPEG 标记损坏');
    const marker=bytes[position+1],length=bytes.readUInt16BE(position+2);
    check(length>=2&&position+2+length<=bytes.length,'头像 JPEG 段长度损坏');
    if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker))
      return {height:bytes.readUInt16BE(position+5),width:bytes.readUInt16BE(position+7)};
    position+=2+length;
  }
  throw new DrillError('头像 JPEG 缺少尺寸信息');
}
const recoveryLocationPoint={longitude:116.3974281,latitude:39.9092301};
function sameLocationPoint(actual,expected) {
  return actual?.longitude===expected.longitude&&actual?.latitude===expected.latitude;
}
async function createActivity(admin,title,capacity=1) {
  return admin.call('/api/admin/activities',{method:'POST',status:201,data:{title,description:'恢复演练：中文、emoji 😀、逗号,引号"与换行\n第二行',
    location:'恢复演练会场',startsAt:new Date(Date.now()+72*3600000).toISOString(),
    endsAt:new Date(Date.now()+74*3600000).toISOString(),
    registrationDeadline:new Date(Date.now()+24*3600000).toISOString(),capacity,category:'TECHNOLOGY',locationPoint:recoveryLocationPoint}});
}
async function bindApiToDatabase(config,api,runId) {
  const db=await connection(config);
  try {
    const [[identity]]=await db.query('SELECT DATABASE() AS name,@@server_uuid AS uuid');
    check(identity.name===config.database&&identity.uuid===config.expectedServerUuid,'恢复应用数据库身份不符');
    const title=`恢复数据库绑定 ${runId}`;
    const [insert]=await db.execute("INSERT INTO activities(title,description,location,starts_at,capacity,created_by) VALUES(?,?,?,UTC_TIMESTAMP(6)+INTERVAL 3 DAY,1,(SELECT id FROM users WHERE username='admin' AND role='ADMIN'))",
      [title,runId,'独立恢复探针']);
    const activity=await api.call(`/api/activities/${insert.insertId}`);
    check(activity.title===title&&activity.description===runId&&activity.endsAt===null&&activity.registrationDeadline===null&&activity.locationPoint===null,'恢复 API 未绑定已核对的新数据库或历史空结束时间/截止时间/坐标未保留');
  } finally {await db.end();}
}
async function prepareFixture(config,origin,runId,adminPassword) {
  const admin=new Api(origin);const actor=await admin.login('admin',adminPassword);
  const password=`Restore${randomBytes(12).toString('hex')}123!`;
  const users=[];
  for(let index=0;index<3;index++) {
    const username=`restore${index}${runId.replaceAll('-','').slice(0,14)}`;
    users.push(await admin.call('/api/auth/register',{method:'POST',status:201,data:{username,password,displayName:`恢复用户 ${index+1} 😀`}}));
  }
  const first=new Api(origin),second=new Api(origin);
  await first.login(users[0].username,password);await second.login(users[1].username,password);
  const avatarFile=new FormData();avatarFile.append('file',new Blob([pngFixture()],{type:'image/png'}),'restore-avatar.png');
  const profile=await first.call('/api/me/avatar',{method:'POST',multipart:avatarFile});
  const avatar=await first.call('/api/me/avatar'),dimensions=jpegDimensions(avatar);
  check(dimensions.width===256&&dimensions.height===256&&profile.avatarUrl===`/api/me/avatar?v=${digest(avatar)}`,'恢复样本头像必须为256像素方形JPEG且资料摘要一致');
  await second.call(profile.avatarUrl,{status:404});
  const main=await createActivity(admin,`备份恢复：中文 😀, 分号; ${runId.slice(0,8)}`);
  check(main.endsAt&&Date.parse(main.endsAt)>Date.parse(main.startsAt),'恢复样本非空结束时间缺失');
  check(sameLocationPoint(main.locationPoint,recoveryLocationPoint),'恢复样本必须保留GCJ02精确坐标');
  check(main.registrationDeadline&&Date.parse(main.registrationDeadline)>Date.now()
    &&Date.parse(main.registrationDeadline)<Date.parse(main.startsAt),'恢复样本报名截止时间必须在未来且早于开始时间');
  check((await first.call(`/api/activities/${main.id}/registration`,{method:'POST'})).registrationStatus==='ACTIVE','恢复样本有效报名失败');
  check((await second.call(`/api/activities/${main.id}/registration`,{method:'POST'})).registrationStatus==='WAITING','恢复样本候补失败');
  await first.call(`/api/activities/${main.id}/registration`,{method:'DELETE'});
  check((await second.call(`/api/activities/${main.id}`)).registrationStatus==='ACTIVE','恢复样本递补失败');
  await first.call(`/api/activities/${main.id}/registration`,{method:'POST'});
  await first.call(`/api/me/favorites/${main.id}`,{method:'POST'});
  const file=new FormData();file.append('file',new Blob([pngFixture()],{type:'image/png'}),'restore-cover.png');
  const withCover=await admin.call(`/api/admin/activities/${main.id}/cover`,{method:'POST',multipart:file});
  const image=await admin.call(withCover.coverUrl);
  const cancelled=await createActivity(admin,`恢复取消 ${runId.slice(0,8)}`);
  await first.call(`/api/activities/${cancelled.id}/registration`,{method:'POST'});
  await admin.call(`/api/admin/activities/${cancelled.id}/cancel`,{method:'POST',data:{reason:'恢复演练取消，保留通知快照'}});
  check(/^gatherrestore[0-9a-f]{32}$/.test(config.database),'签到结构样本仅允许写入本轮新建恢复库');
  const db=await connection(config);let startedId,registrationId,selfRegistrationId,uncheckedRegistrationId;
  try {
    const [activity]=await db.execute('INSERT INTO activities(title,description,location,starts_at,capacity,registered_count,created_by) VALUES(?,?,?,UTC_TIMESTAMP(6)-INTERVAL 1 HOUR,3,3,?)',
      [`恢复签到 ${runId.slice(0,8)}`,`${runId}：V15 SELF_LOCATION 为独立恢复库结构样本，不代表定位业务 API 成功`,'独立恢复签到样本',actor.id]);startedId=activity.insertId;
    const [registration]=await db.execute("INSERT INTO registrations(activity_id,user_id,status) VALUES(?,?,'ACTIVE')",[startedId,users[0].id]);registrationId=registration.insertId;
    // Construct a storage-shape sample only in the new restore database. No user
    // coordinates are persisted and no historical self-check-in audit is invented.
    const [self]=await db.execute("INSERT INTO registrations(activity_id,user_id,status,checked_in_at,check_in_method,check_in_version) VALUES(?,?,'ACTIVE',UTC_TIMESTAMP(6),'SELF_LOCATION',7)",[startedId,users[1].id]);selfRegistrationId=self.insertId;
    const [unchecked]=await db.execute("INSERT INTO registrations(activity_id,user_id,status) VALUES(?,?,'ACTIVE')",[startedId,users[2].id]);uncheckedRegistrationId=unchecked.insertId;
  } finally {await db.end();}
  await admin.call(`/api/admin/activities/${startedId}/registrations/${registrationId}/check-in`,{method:'POST'});
  const verifyDb=await connection(config);let checkInRows;
  try {[checkInRows]=await verifyDb.execute('SELECT id,status,created_at,updated_at,checked_in_at,checked_in_by,check_in_method,check_in_version FROM registrations WHERE activity_id=? ORDER BY id',[startedId]);}
  finally {await verifyDb.end();}
  return {main:withCover,cancelledId:cancelled.id,startedId,registrationId,selfRegistrationId,uncheckedRegistrationId,checkInRows,users,password,imageHash:digest(image),imageBytes:image.length,
    avatarHash:digest(avatar),avatarBytes:avatar.length};
}

async function startWeb(port,apiPort) {
  const directory=await realpath(join(root,'frontend/dist'));
  const mime={'.html':'text/html;charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
  const server=createServer(async(req,res)=>{
    try {
      const origin=`http://127.0.0.1:${port}`,url=new URL(req.url,origin);
      if(url.origin!==origin) {res.writeHead(400).end();return;}
      if(url.pathname.startsWith('/api/')) {
        const upstream=proxyRequest({host:'127.0.0.1',port:apiPort,path:url.pathname+url.search,method:req.method,
          headers:{...req.headers,host:`127.0.0.1:${apiPort}`}},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});
        upstream.on('error',()=>res.writeHead(502).end());req.pipe(upstream);return;
      }
      let file=resolve(directory,'.'+decodeURIComponent(url.pathname));
      if(!file.startsWith(directory+sep)) file=join(directory,'index.html');
      try {if(!(await stat(file)).isFile()) throw new Error();}
      catch {if(url.pathname.startsWith('/assets/')) {res.writeHead(404,{'Cache-Control':'no-store'}).end();return;}file=join(directory,'index.html');}
      res.writeHead(200,{'Content-Type':mime[extname(file)]??'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
      createReadStream(file).on('error',()=>res.destroy()).pipe(res);
    } catch {res.writeHead(400).end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});return server;
}
async function verifyRecovered(origin,fixture,adminPassword,config) {
  const admin=new Api(origin);const adminIdentity=await admin.login('admin',adminPassword);
  check(digest(await admin.call(fixture.main.coverUrl))===fixture.imageHash,'恢复后的 JPEG 字节摘要不一致');
  const recovered=await admin.call(`/api/activities/${fixture.main.id}`);
  check(recovered.endsAt===fixture.main.endsAt,'恢复后的非空结束时间不一致');
  check(recovered.registrationDeadline===fixture.main.registrationDeadline,'恢复后的非空报名截止时间不一致');
  check(sameLocationPoint(recovered.locationPoint,recoveryLocationPoint),'恢复后的详情GCJ02精确坐标不一致');
  const legacy=await admin.call(`/api/activities/${fixture.startedId}`);
  check(legacy.endsAt===null&&legacy.registrationDeadline===null&&legacy.locationPoint===null,'恢复后的历史空结束时间、截止时间或坐标不一致');
  const first=new Api(origin),second=new Api(origin);
  const owner=await first.login(fixture.users[0].username,fixture.password);
  const other=await second.login(fixture.users[1].username,fixture.password);
  check(owner.avatarUrl===`/api/me/avatar?v=${fixture.avatarHash}`&&other.avatarUrl===null,'恢复后的本人头像元数据或他人空头像不一致');
  const avatar=await first.call(owner.avatarUrl),dimensions=jpegDimensions(avatar);
  check(digest(avatar)===fixture.avatarHash&&avatar.length===fixture.avatarBytes&&dimensions.width===256&&dimensions.height===256,'恢复后的头像完整字节、摘要或256像素尺寸不一致');
  await second.call(owner.avatarUrl,{status:404});
  await new Api(origin).call(owner.avatarUrl,{status:401});
  const history=await first.call('/api/me/registrations/search?pageSize=100');
  check(history.items.some(row=>row.activity.id===fixture.startedId&&row.checkedInAt&&row.checkInMethod==='ADMIN'&&row.checkInVersion===1&&row.activity.registrationDeadline===null&&row.activity.locationPoint===null),'恢复后的本人管理员签到方式、版本或记录缺失');
  const selfHistory=await second.call('/api/me/registrations/search?pageSize=100');
  check(selfHistory.items.some(row=>row.activity.id===fixture.startedId&&row.checkedInAt&&row.checkInMethod==='SELF_LOCATION'&&row.checkInVersion===7),'恢复后的定位签到结构样本方式/版本缺失');
  const db=await connection(config);
  try {
    const [rows]=await db.execute('SELECT id,status,created_at,updated_at,checked_in_at,checked_in_by,check_in_method,check_in_version FROM registrations WHERE activity_id=? ORDER BY id',[fixture.startedId]);
    check(JSON.stringify(rows)===JSON.stringify(fixture.checkInRows),'恢复后的签到方式/版本或原始时间/管理员字段发生变化');
    const [[sampleAudit]]=await db.execute('SELECT COUNT(*) AS total FROM activity_audit_logs WHERE registration_id=?',[fixture.selfRegistrationId]);
    check(Number(sampleAudit.total)===0,'结构样本不能伪造历史定位签到审计');
  } finally {await db.end();}
  check(history.items.some(row=>row.activity.id===fixture.main.id&&row.status==='WAITING'&&row.activity.endsAt===fixture.main.endsAt&&row.activity.registrationDeadline===fixture.main.registrationDeadline&&sameLocationPoint(row.activity.locationPoint,recoveryLocationPoint)),'恢复后的候补记录、截止时间或坐标缺失');
  check(history.items.some(row=>row.activity.id===fixture.cancelledId&&row.status==='CANCELLED'),'恢复后的取消历史缺失');
  const favorites=await first.call('/api/me/favorites');
  check(favorites.items.some(row=>row.activity.id===fixture.main.id&&row.activity.endsAt===fixture.main.endsAt&&row.activity.registrationDeadline===fixture.main.registrationDeadline&&sameLocationPoint(row.activity.locationPoint,recoveryLocationPoint)),'恢复后的收藏、结束时间、截止时间或坐标缺失');
  check((await second.call('/api/me/notifications?status=ALL')).total>0,'恢复后的递补通知缺失');
  check((await admin.call(`/api/admin/audit-logs?activityId=${fixture.main.id}`)).total>=2,'恢复后的操作记录缺失');
  const rosterPath=`/api/admin/activities/${fixture.startedId}/registrations`;
  const roster=await admin.call(rosterPath);
  const self=roster.items.find(row=>row.id===Number(fixture.selfRegistrationId));
  const unchecked=roster.items.find(row=>row.id===Number(fixture.uncheckedRegistrationId));
  check(self?.checkedInAt&&self.checkedInBy===null&&self.checkInMethod==='SELF_LOCATION'&&self.checkInVersion===7,'恢复后的定位结构样本不能被归为管理员签到');
  check(unchecked?.checkedInAt===null&&unchecked.checkedInBy===null&&unchecked.checkInMethod===null&&unchecked.checkInVersion===0,'恢复后的未签到三空字段/零版本错误');
  const csv=await admin.call(rosterPath+'/export');
  check(csv.split('\r\n')[0].endsWith(',"签到方式"')&&csv.includes(',"管理员签到"\r\n')&&csv.includes(',"定位签到"\r\n'),'恢复 CSV 必须在末列追加管理员/定位签到方式');
  const correctionPath=`${rosterPath}/${fixture.selfRegistrationId}/check-in`;
  const revoked=await admin.call(correctionPath,{method:'PATCH',data:{checkedIn:false,reason:'恢复演练撤销定位结构样本',expectedVersion:7}});
  check(revoked.checkedInAt===null&&revoked.checkedInBy===null&&revoked.checkInMethod===null&&revoked.checkInVersion===8&&revoked.updatedAt===self.updatedAt,'管理员撤销必须递增版本并保留报名更新时间');
  const stale=await admin.call(correctionPath,{method:'PATCH',status:409,data:{checkedIn:true,reason:'恢复演练过期版本',expectedVersion:7}});
  check(stale.code==='CHECK_IN_VERSION_CONFLICT','过期签到版本必须明确冲突');
  const corrected=await admin.call(correctionPath,{method:'PATCH',data:{checkedIn:true,reason:'恢复演练管理员补签',expectedVersion:8}});
  check(corrected.checkedInAt&&corrected.checkInMethod==='ADMIN'&&corrected.checkedInBy===adminIdentity.id&&corrected.checkInVersion===9&&corrected.updatedAt===self.updatedAt,'管理员补签必须使用管理员方式、可信管理员、递增版本并保留报名更新时间');
  const revocations=await admin.call(`/api/admin/audit-logs?activityId=${fixture.startedId}&action=CHECK_IN_REVOKE`);
  check(revocations.total===1,'首次撤销必须生成一个 CHECK_IN_REVOKE 审计');
  const revocation=await admin.call(`/api/admin/audit-logs/${revocations.items[0].id}`);
  check(revocation.changes.some(change=>change.field==='checkInReason'&&change.after==='恢复演练撤销定位结构样本'),'撤销审计必须保留原因');
  return {admin,checks:['nullable-and-nonnull-location-point-exact-gcj02','location-point-detail-registration-favorite-projections','nullable-and-nonnull-registration-deadline','nullable-and-nonnull-end-time','cover-byte-sha256','avatar-byte-sha256-256-jpeg','avatar-owner-authentication-and-no-store','credentials-and-roles','active-waiting-cancelled-history','real-admin-check-in-and-audit','v15-admin-self-location-unchecked-storage-shapes-and-versions','v15-original-registration-timestamps-and-admin-preserved','self-location-is-restore-only-structure-sample-without-business-api-evidence','csv-appended-check-in-method-column','real-admin-correction-revoke-reason-version-conflict-api','favorites','notifications','audit-log']};
}
async function verifyConstraints(config,fixture) {
  const db=await connection(config);
  try {
    check(Number((await db.query('SELECT @@foreign_key_checks AS enabled'))[0][0].enabled)===1,'恢复连接未启用外键检查');
    await db.beginTransaction();
    for(const [sql,args,code] of [
      ['INSERT INTO activity_favorites(user_id,activity_id) VALUES(-1,-1)',[],'ER_NO_REFERENCED_ROW_2'],
      ['INSERT INTO activity_favorites(user_id,activity_id) VALUES(?,?)',[fixture.users[0].id,fixture.main.id],'ER_DUP_ENTRY'],
      ['UPDATE activities SET registered_count=capacity+1 WHERE id=?',[fixture.main.id],'ER_CHECK_CONSTRAINT_VIOLATED'],
      ['UPDATE activities SET ends_at=starts_at WHERE id=?',[fixture.main.id],'ER_CHECK_CONSTRAINT_VIOLATED'],
      ['UPDATE activities SET ends_at=starts_at-INTERVAL 1 MICROSECOND WHERE id=?',[fixture.main.id],'ER_CHECK_CONSTRAINT_VIOLATED'],
      ['UPDATE activities SET registration_deadline=starts_at WHERE id=?',[fixture.main.id],'ER_CHECK_CONSTRAINT_VIOLATED'],
      ['UPDATE activities SET registration_deadline=starts_at+INTERVAL 1 MICROSECOND WHERE id=?',[fixture.main.id],'ER_CHECK_CONSTRAINT_VIOLATED'],
      ['UPDATE activities SET location_longitude=NULL WHERE id=?',[fixture.main.id],'ER_CHECK_CONSTRAINT_VIOLATED'],
      ['UPDATE activities SET location_latitude=NULL WHERE id=?',[fixture.main.id],'ER_CHECK_CONSTRAINT_VIOLATED'],
      ['UPDATE activities SET location_longitude=180.0000001 WHERE id=?',[fixture.main.id],'ER_CHECK_CONSTRAINT_VIOLATED'],
      ['UPDATE activities SET location_longitude=-180.0000001 WHERE id=?',[fixture.main.id],'ER_CHECK_CONSTRAINT_VIOLATED'],
      ['UPDATE activities SET location_latitude=90.0000001 WHERE id=?',[fixture.main.id],'ER_CHECK_CONSTRAINT_VIOLATED'],
      ['UPDATE activities SET location_latitude=-90.0000001 WHERE id=?',[fixture.main.id],'ER_CHECK_CONSTRAINT_VIOLATED'],
      ['UPDATE users SET avatar_hash=NULL WHERE id=?',[fixture.users[0].id],'ER_CHECK_CONSTRAINT_VIOLATED'],
      ['UPDATE users SET avatar_image=NULL WHERE id=?',[fixture.users[0].id],'ER_CHECK_CONSTRAINT_VIOLATED'],
      ["UPDATE users SET avatar_hash=REPEAT('g',64) WHERE id=?",[fixture.users[0].id],'ER_CHECK_CONSTRAINT_VIOLATED'],
      ["UPDATE users SET avatar_image=X'' WHERE id=?",[fixture.users[0].id],'ER_CHECK_CONSTRAINT_VIOLATED'],
      ['UPDATE registrations SET check_in_version=-1 WHERE id=?',[fixture.registrationId],'ER_CHECK_CONSTRAINT_VIOLATED'],
      ['UPDATE registrations SET check_in_method=NULL WHERE id=?',[fixture.registrationId],'ER_CHECK_CONSTRAINT_VIOLATED'],
      ["UPDATE registrations SET check_in_method='self_location' WHERE id=?",[fixture.selfRegistrationId],'ER_CHECK_CONSTRAINT_VIOLATED'],
      ["UPDATE registrations SET check_in_method='ADMIN' WHERE id=?",[fixture.selfRegistrationId],'ER_CHECK_CONSTRAINT_VIOLATED'],
      ["UPDATE registrations SET checked_in_by=? WHERE id=?",[fixture.users[0].id,fixture.selfRegistrationId],'ER_CHECK_CONSTRAINT_VIOLATED'],
      ["UPDATE registrations SET status='WAITING' WHERE id=?",[fixture.selfRegistrationId],'ER_CHECK_CONSTRAINT_VIOLATED'],
      ["UPDATE registrations SET check_in_method='SELF_LOCATION' WHERE id=?",[fixture.uncheckedRegistrationId],'ER_CHECK_CONSTRAINT_VIOLATED'],
      ["UPDATE activity_audit_logs SET action='CHECK_IN_REVOKE' WHERE activity_id=? AND registration_id IS NULL",[fixture.main.id],'ER_CHECK_CONSTRAINT_VIOLATED'],
      ["UPDATE activity_audit_logs SET registration_id=NULL WHERE activity_id=? AND action='CHECK_IN'",[fixture.startedId],'ER_CHECK_CONSTRAINT_VIOLATED'],
    ]) {
      let rejected=false;
      try {await db.execute(sql,args);} catch(error) {rejected=error.code===code;}
      check(rejected,'恢复后的外键、唯一键、名额、时间、坐标、头像、签到方式/版本或审计目标约束未按预期拒绝非法数据');
    }
    const [[point]]=await db.execute('SELECT location_longitude,location_latitude FROM activities WHERE id=?',[fixture.main.id]);
    check(point.location_longitude==='116.3974281'&&point.location_latitude==='39.9092301','恢复数据库未精确保留七位小数坐标');
    const [[oldPoint]]=await db.execute('SELECT location_longitude,location_latitude FROM activities WHERE id=?',[fixture.startedId]);
    check(oldPoint.location_longitude===null&&oldPoint.location_latitude===null,'恢复数据库历史空坐标未保留');
    await db.execute('UPDATE activities SET location_longitude=NULL,location_latitude=NULL WHERE id=?',[fixture.main.id]);
    const [[noPoint]]=await db.execute('SELECT location_longitude,location_latitude FROM activities WHERE id=?',[fixture.main.id]);
    check(noPoint.location_longitude===null&&noPoint.location_latitude===null,'恢复后的坐标约束必须允许成对空值');
    for(const [longitude,latitude] of [[-180,-90],[180,90]]) {
      await db.execute('UPDATE activities SET location_longitude=?,location_latitude=? WHERE id=?',[longitude,latitude,fixture.main.id]);
      const [[edge]]=await db.execute('SELECT location_longitude,location_latitude FROM activities WHERE id=?',[fixture.main.id]);
      check(Number(edge.location_longitude)===longitude&&Number(edge.location_latitude)===latitude,'恢复后的坐标约束必须允许经纬度端点');
    }
    await db.execute('UPDATE activities SET registration_deadline=NULL WHERE id=?',[fixture.main.id]);
    const [[nullable]]=await db.execute('SELECT registration_deadline FROM activities WHERE id=?',[fixture.main.id]);
    check(nullable.registration_deadline===null,'恢复后的报名截止时间约束必须允许空值');
    await db.execute('UPDATE activities SET registration_deadline=starts_at-INTERVAL 1 MICROSECOND WHERE id=?',[fixture.main.id]);
    const [[strict]]=await db.execute('SELECT registration_deadline=starts_at-INTERVAL 1 MICROSECOND AS valid FROM activities WHERE id=?',[fixture.main.id]);
    check(Number(strict.valid)===1,'恢复后的报名截止时间约束必须允许早于开始时间一微秒');
    await db.execute('UPDATE users SET avatar_image=NULL,avatar_hash=NULL WHERE id=?',[fixture.users[0].id]);
    const [[emptyAvatar]]=await db.execute('SELECT avatar_image,avatar_hash FROM users WHERE id=?',[fixture.users[0].id]);
    check(emptyAvatar.avatar_image===null&&emptyAvatar.avatar_hash===null,'恢复后的头像必须允许成对空值');
    await db.rollback();
  } finally {await db.end();}
}
async function verifyBrowser(origin,fixture,admin,directory) {
  const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'chrome'});
  const results=[];
  try {
    for(const [name,options] of [['desktop',{viewport:{width:1280,height:900}}],['mobile',{...devices['iPhone 13']}]]) {
      const context=await browser.newContext({...options,baseURL:origin});
      try {
        const page=await context.newPage();await page.goto('/activities');
        await expect(page.getByRole('heading',{name:'发现活动',exact:true})).toBeVisible();
        await page.goto(`/activities/${fixture.main.id}`);
        await expect(page.getByRole('heading',{name:fixture.main.title,exact:true})).toBeVisible();
        await expect(page.getByRole('button',{name:'查看地图',exact:true})).toBeVisible();
        const navigation=page.getByRole('link',{name:'在高德查看 / 导航',exact:true});
        await expect(navigation).toBeVisible();
        const navigationUrl=new URL(await navigation.getAttribute('href'));
        check(navigationUrl.origin==='https://uri.amap.com'&&navigationUrl.pathname==='/marker'
          &&navigationUrl.searchParams.get('position')==='116.3974281,39.9092301'
          &&navigationUrl.searchParams.get('coordinate')==='gaode'&&navigationUrl.searchParams.get('callnative')==='0','恢复详情导航未使用持久化GCJ02坐标');
        const cover=page.getByRole('img',{name:`${fixture.main.title}的活动封面`,exact:true});await expect(cover).toBeVisible();
        await expect.poll(()=>cover.evaluate(image=>image.naturalWidth)).toBeGreaterThan(0);
        await page.goto(`/activities/${fixture.startedId}`);
        await expect(page.getByText('未设置地图位置',{exact:true})).toBeVisible();
        await expect(page.getByRole('button',{name:'查看地图',exact:true})).toHaveCount(0);
        await page.goto('/login');await page.getByLabel('账号',{exact:true}).fill(fixture.users[0].username);
        await page.getByLabel('密码',{exact:true}).fill(fixture.password);await page.getByRole('button',{name:'登录',exact:true}).click();
        await expect(page.getByRole('button',{name:/账号菜单/})).toBeVisible();
        const smoke=await createActivity(admin,`恢复后浏览器报名 ${name}`,3);
        await page.goto(`/activities/${smoke.id}`);await page.getByRole('button',{name:'立即报名',exact:true}).click();
        await expect(page.getByRole('heading',{name:'你的名额已确认',exact:true})).toBeVisible();
        await page.getByRole('button',{name:'取消报名',exact:true}).click();
        await page.getByRole('button',{name:'确认取消',exact:true}).click();
        await expect(page.getByRole('button',{name:'重新报名',exact:true})).toBeVisible();
        check((await admin.call(`/api/activities/${smoke.id}`)).registeredCount===0,'恢复后的浏览器取消未释放名额');
        await page.goto(`/activities/${fixture.main.id}`);await expect(cover).toBeVisible();
        await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
        await page.screenshot({path:join(directory,`recovered-${name}.png`),fullPage:true});results.push({viewport:name,locationPoint:'exact-persisted-navigation-and-null-history',passed:true});
      } finally {await context.close();}
    }
  } finally {await browser.close();}
  return results;
}

export async function runDrill() {
  const required=['BACKUP_DB_PORT','BACKUP_DB_NAME','BACKUP_DB_USER','BACKUP_DB_PASSWORD','BACKUP_DB_SERVER_UUID','BACKUP_MYSQL_BIN_DIR','BACKUP_JAVA_BIN','BACKUP_DEMO_ADMIN_PASSWORD'];
  check(required.every(name=>process.env[name]),'恢复演练缺少显式配置');
  const source={host:process.env.BACKUP_DB_HOST,port:Number(process.env.BACKUP_DB_PORT),database:process.env.BACKUP_DB_NAME,
    user:process.env.BACKUP_DB_USER,password:process.env.BACKUP_DB_PASSWORD,expectedServerUuid:process.env.BACKUP_DB_SERVER_UUID,binDir:resolve(process.env.BACKUP_MYSQL_BIN_DIR)};
  check(source.host==='127.0.0.1'&&source.database==='activity_platform','演练源必须是已明确指定的本机演示库');
  const ports={mysql:33418,a:18091,b:18092,web:18589};for(const port of Object.values(ports)) await freePort(port);
  const runId=randomUUID(),directory=join(root,'.runtime/restore-drills',runId);
  await secureRuntimeDirectory(dirname(directory));
  await mkdir(directory,{recursive:true,mode:0o700});check(await realpath(directory)===resolve(directory),'演练目录不能是符号链接');
  const report={runId,schemaVersion:15,startedAt:new Date().toISOString(),phase:'capture-source',completed:false,sourcePreserved:false,checks:[],browser:[]};
  const children=[],webServers=[];let adminDb,initial,daemon;
  try {
    initial=await fullSnapshot(source);
    report.phase='backup-original';
    const original=await createBackup(source);report.originalBackup={directory:original.directory,manifest:original.manifest};
    report.phase='initialize-independent-mysql';
    const server=join(source.binDir,process.platform==='win32'?'mysqld.exe':'mysqld'),data=join(directory,'mysql-data');await mkdir(data,{mode:0o700});
    const initialized=await startChild(server,['--no-defaults','--initialize-insecure',`--basedir=${dirname(source.binDir)}`,`--datadir=${data}`],childEnvironment(),join(directory,'mysql-initialize.log'),children);
    check(await initialized.exited===0,'独立 MySQL 初始化失败');
    const adminPassword=randomBytes(24).toString('hex'),init=join(directory,'bootstrap.sql');
    await writeFile(init,`ALTER USER 'root'@'localhost' IDENTIFIED BY '${adminPassword}';\nCREATE USER 'drilladmin'@'127.0.0.1' IDENTIFIED BY '${adminPassword}';\nGRANT ALL PRIVILEGES ON *.* TO 'drilladmin'@'127.0.0.1' WITH GRANT OPTION;\n`,{flag:'wx',mode:0o600});
    daemon=await startChild(server,['--no-defaults',`--basedir=${dirname(source.binDir)}`,`--datadir=${data}`,`--port=${ports.mysql}`,'--bind-address=127.0.0.1','--mysqlx=OFF','--skip-name-resolve',
      '--character-set-server=utf8mb4','--collation-server=utf8mb4_0900_ai_ci','--default-time-zone=+00:00','--innodb-buffer-pool-size=64M','--innodb-redo-log-capacity=64M',
      `--init-file=${init}`,`--log-error=${join(directory,'mysql-error.log')}`],childEnvironment(),join(directory,'mysql-console.log'),children);
    const end=Date.now()+90000;
    while(Date.now()<end) {check(daemon.child.exitCode===null&&daemon.child.signalCode===null,'独立 MySQL 在就绪前退出');try {adminDb=await mysql.createConnection({host:'127.0.0.1',port:ports.mysql,user:'drilladmin',password:adminPassword,connectTimeout:1000});break;}catch {await wait(500);}}
    check(adminDb,'独立 MySQL 未就绪');const [[identity]]=await adminDb.query('SELECT @@server_uuid AS uuid,VERSION() AS version');
    check(identity.uuid!==source.expectedServerUuid&&identity.version.startsWith('8.4.'),'恢复服务器必须是不同 UUID 的 MySQL 8.4');report.independentServer=true;
    async function target() {
      const database='gatherrestore'+randomUUID().replaceAll('-',''),user='grestore'+randomBytes(8).toString('hex'),password=randomBytes(24).toString('hex');
      await adminDb.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
      await adminDb.query(`CREATE USER '${user}'@'127.0.0.1' IDENTIFIED BY '${password}'`);
      await adminDb.query(`GRANT ALL PRIVILEGES ON \`${database}\`.* TO '${user}'@'127.0.0.1'`);
      return {host:'127.0.0.1',port:ports.mysql,database,user,password,expectedServerUuid:identity.uuid,binDir:source.binDir};
    }
    async function application(config,port,label) {
      const owned=await startChild(resolve(process.env.BACKUP_JAVA_BIN),['-jar',join(root,'backend/target/gather-backend.jar')],childEnvironment({
        DB_URL:`jdbc:mysql://127.0.0.1:${config.port}/${config.database}?characterEncoding=UTF-8&connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true`,
        DB_USERNAME:config.user,DB_PASSWORD:config.password,PORT:String(port),SERVER_ADDRESS:'127.0.0.1',DEMO_SEED_ENABLED:'false',
        SERVER_SERVLET_SESSION_COOKIE_NAME:`GATHER_RESTORE_${label}_${runId.replaceAll('-','')}`,INSTANCE_ID:`restore-${label}`,
      }),join(directory,`backend-${label}.log`),children);
      const origin=`http://127.0.0.1:${port}`;await waitHealthy(origin,owned);return origin;
    }
    report.phase='restore-original';
    const first=await target();report.firstRestore=await restoreBackup(original.directory,first);
    report.phase='start-first-application';
    const originA=await application(first,ports.a,'a');await bindApiToDatabase(first,new Api(originA),randomUUID());
    report.phase='prepare-complete-fixture';
    const fixture=await prepareFixture(first,originA,runId,process.env.BACKUP_DEMO_ADMIN_PASSWORD);
    report.phase='backup-complete-fixture';
    const enriched=await createBackup(first);report.enrichedBackup={directory:enriched.directory,manifest:enriched.manifest};
    report.phase='restore-complete-fixture';
    const second=await target();report.secondRestore=await restoreBackup(enriched.directory,second);
    report.phase='verify-recovered-application';
    const originB=await application(second,ports.b,'b');await bindApiToDatabase(second,new Api(originB),randomUUID());
    await verifyConstraints(second,fixture);
    const verified=await verifyRecovered(originB,fixture,process.env.BACKUP_DEMO_ADMIN_PASSWORD,second);report.checks=verified.checks;
    report.checks.push('foreign-key-unique-capacity-end-time-registration-deadline-location-avatar-check-in-version-method-and-audit-target-enforcement');
    webServers.push(await startWeb(ports.web,ports.b));
    report.phase='verify-browser';
    report.browser=await verifyBrowser(`http://127.0.0.1:${ports.web}`,fixture,verified.admin,directory);
    report.phase='verify-original-preserved';
    check(JSON.stringify(await fullSnapshot(source))===JSON.stringify(initial),'演示库摘要发生变化，不能声明数据保持一致');
    report.sourcePreserved=true;report.completed=true;report.phase='complete';
  } finally {
    for(const server of webServers) {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    for(const owned of children.slice().reverse().filter(item=>item!==daemon)) {
      if(owned.child.exitCode===null&&owned.child.signalCode===null) owned.child.kill();await owned.exited;await owned.file.close();
    }
    let cleanupFailed=false;
    if(adminDb) {try {await adminDb.query('SHUTDOWN');} catch {cleanupFailed=true;} await adminDb.end();}
    if(daemon) {
      const closed=await Promise.race([daemon.exited.then(()=>true),wait(15000).then(()=>false)]);
      if(!closed) {cleanupFailed=true;daemon.child.kill();await daemon.exited;}
      await daemon.file.close();
    }
    report.cleanupGraceful=!cleanupFailed;
    if(cleanupFailed) report.completed=false;
    if(initial&&!report.sourcePreserved) {
      try {report.sourcePreserved=JSON.stringify(await fullSnapshot(source))===JSON.stringify(initial);} catch {report.sourcePreserved=false;}
    }
    report.finishedAt=new Date().toISOString();report.seconds=(Date.parse(report.finishedAt)-Date.parse(report.startedAt))/1000;
    await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(JSON.stringify({directory,phase:report.phase,completed:report.completed,sourcePreserved:report.sourcePreserved,seconds:report.seconds,browser:report.browser}));
    if(cleanupFailed) throw new DrillError('演练服务未能正常关闭，请检查受限目录中的阶段报告');
  }
}
export {Api as RestoreDrillApi,childEnvironment as restoreChildEnvironment};
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  runDrill().catch(error=>{console.error(error instanceof DrillError?error.message:'恢复演练未完成；请检查忽略目录中的安全阶段报告。');process.exitCode=1;});
}
