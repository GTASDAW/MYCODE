import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import mysql from 'mysql2/promise';
import {test,expect,type APIRequestContext,type Download,type Page,type TestInfo} from '@playwright/test';
import {trackFixture,recordFixtureId,recordFixtureEditIntent,trackAccount,recordAccountId,databaseConfig,verifyDatabase} from '../scripts/e2e-cleanup.mjs';

test.use({trace:'off'});
async function write(request:APIRequestContext,path:string,data?:unknown) {
  const csrf=await (await request.get('/api/auth/csrf')).json();
  return request.post(path,{headers:{[csrf.headerName]:csrf.token},data});
}
async function admin(request:APIRequestContext) {
  const csrf=await (await request.get('/api/auth/csrf')).json();
  const result=await request.post('/api/auth/login',{headers:{[csrf.headerName]:csrf.token},form:{username:'admin',password:'Admin123!'}});
  expect(result.status()).toBe(200);return result.json();
}
async function account(request:APIRequestContext) {
  const intent=trackAccount();
  const response=await write(request,'/api/auth/register',{username:intent.username,password:'Demo123!',displayName:intent.displayName});
  expect(response.status()).toBe(201);const user=await response.json();recordAccountId(intent.key,user.id);return user;
}
async function login(page:Page,name:string) {
  await page.goto('/login');await page.getByLabel('账号',{exact:true}).fill(name);
  await page.getByLabel('密码',{exact:true}).fill(name==='admin'?'Admin123!':'Demo123!');
  await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('button',{name:/账号菜单/})).toBeVisible();
}
async function logout(page:Page) {
  await page.getByRole('button',{name:/账号菜单/}).click();await page.getByRole('menuitem',{name:/退出登录/}).click();
  await expect(page.getByRole('button',{name:'登录 / 体验',exact:true})).toBeVisible();
}
async function create(request:APIRequestContext,info:TestInfo,started=false) {
  const intent=trackFixture(`日历 ${info.project.name} ${randomUUID().slice(0,8)} 中文😀,;`,
    '日历导出真实验证，中文😀、逗号,分号;反斜杠\\与换行。\r\nEND:VEVENT\nBEGIN:VEVENT\nATTENDEE:不应成为属性\n'+ '长介绍🚀'.repeat(30));
  if(started) {
    const config=databaseConfig(),connection=await mysql.createConnection(config);
    try {
      const manifest=JSON.parse(readFileSync(process.env.E2E_RUN_MANIFEST!,'utf8'));
      await verifyDatabase(connection,config,manifest.target);
      const me=await (await request.get('/api/auth/me')).json();expect(me).toMatchObject({username:'admin',role:'ADMIN'});
      const [actors]=await connection.execute<any[]>("SELECT id FROM users WHERE id=? AND username='admin' AND role='ADMIN'",[me.id]);expect(actors).toHaveLength(1);
      const [inserted]=await connection.execute<mysql.ResultSetHeader>(
        "INSERT INTO activities(title,description,location,starts_at,capacity,registered_count,created_by) VALUES(?,?,?,UTC_TIMESTAMP(6)-INTERVAL 1 HOUR,2,0,?)",
        [intent.title,intent.description,'日历,会场;\\中文',me.id]);
      recordFixtureId(intent.key,inserted.insertId);
      const response=await request.get(`/api/activities/${inserted.insertId}`);expect(response.status()).toBe(200);
      return {...await response.json(),fixtureKey:intent.key};
    } finally {await connection.end();}
  }
  const response=await write(request,'/api/admin/activities',{title:intent.title,description:intent.description,location:'日历,会场;\\中文',
    startsAt:new Date(Date.now()+48*3600000).toISOString(),capacity:2,category:'TECHNOLOGY'});
  expect(response.status()).toBe(201);const activity=await response.json();recordFixtureId(intent.key,activity.id);
  return {...activity,fixtureKey:intent.key};
}
async function open(page:Page,activity:{id:number;title:string},suffix='') {
  await page.goto(`/activities/${activity.id}${suffix}`);
  await expect(page.getByRole('heading',{name:activity.title,exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'下载日历',exact:true})).toBeVisible();
}
const unfold=(text:string)=>text.replace(/\r\n[ \t]/g,'');
const decode=(text:string)=>text.replace(/\\([nN\\,;])/g,(_,value:string)=>/[nN]/.test(value)?'\n':value);
async function readCalendar(download:Download,activity:any,origin:string) {
  expect(download.suggestedFilename()).toBe(`activity-${activity.id}.ics`);expect(await download.failure()).toBeNull();
  const path=await download.path();expect(path).not.toBeNull();const bytes=readFileSync(path!);
  expect([...bytes.subarray(0,3)]).toEqual([66,69,71]);const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  for(const line of text.split('\r\n')) expect(Buffer.byteLength(line,'utf8')).toBeLessThanOrEqual(75);
  expect(text.replaceAll('\r\n','')).not.toMatch(/[\r\n]/);
  const lines=unfold(text).split('\r\n');
  expect(lines.filter(line=>line==='BEGIN:VEVENT')).toHaveLength(1);expect(lines.filter(line=>line==='END:VEVENT')).toHaveLength(1);
  for(const property of ['DTEND:','DURATION:','ATTENDEE:','ORGANIZER:','TRIGGER:','BEGIN:VALARM']) expect(lines.some(line=>line.startsWith(property))).toBe(false);
  const property=(name:string)=>lines.find(line=>line.startsWith(`${name}:`))!.slice(name.length+1);
  expect(decode(property('SUMMARY'))).toBe(activity.title);
  expect(decode(property('LOCATION'))).toBe(activity.location);
  expect(decode(property('DESCRIPTION'))).toContain(activity.description.replace(/\r\n|\r/g,'\n'));
  expect(property('UID')).toBe(`${origin}/activities/${activity.id}`);expect(property('URL')).toBe(property('UID'));
  const [,year,month,day,hour,minute,second]=property('DTSTART').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/)!;
  expect(Date.UTC(+year,+month-1,+day,+hour,+minute,+second)).toBe(Math.floor(Date.parse(activity.startsAt)/1000)*1000);
  return text;
}
async function download(page:Page,activity:any) {
  const saved=page.waitForEvent('download');await page.getByRole('button',{name:'下载日历',exact:true}).click();
  return readCalendar(await saved,activity,new URL(page.url()).origin);
}

test('匿名和登录均下载最新公开资料，中文转义与稳定UID正确，不覆盖页面或泄露来源',async({page,request},info)=>{
  await admin(request);const activity=await create(request,info),user=await account(request);
  const from='/my-favorites?page=2&pageSize=20';await open(page,activity,`?${new URLSearchParams({from})}`);
  const edited={...activity,title:`更新 ${activity.title}`,location:'更新会场,;😀'};
  recordFixtureEditIntent(activity.fixtureKey,edited.title,edited.description);
  const csrf=await (await request.get('/api/auth/csrf')).json();
  expect((await request.patch(`/api/admin/activities/${activity.id}`,{headers:{[csrf.headerName]:csrf.token},data:{title:edited.title,description:edited.description,location:edited.location,category:edited.category}})).status()).toBe(200);
  const first=await download(page,edited);expect(first).not.toContain('my-favorites');expect(first).not.toContain('pageSize=');
  await expect(page.getByRole('heading',{name:activity.title,exact:true})).toBeVisible();
  await login(page,user.username);await open(page,edited);
  const second=await download(page,edited);
  expect(unfold(first).match(/^UID:.*$/m)?.[0]).toBe(unfold(second).match(/^UID:.*$/m)?.[0]);
  expect(second).not.toContain(user.username);expect(second).not.toContain('registrationStatus');
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  const shot=info.outputPath('calendar-detail.png');await page.screenshot({path:shot,fullPage:true});await info.attach('calendar-detail',{path:shot,contentType:'image/png'});
});

test('已开始活动可补录，已取消活动禁用，点击前新取消会拒绝下载并可刷新详情',async({page,request},info)=>{
  await admin(request);const started=await create(request,info,true),cancelled=await create(request,info),stale=await create(request,info);
  await open(page,started);await download(page,started);
  expect((await write(request,`/api/admin/activities/${cancelled.id}/cancel`,{reason:'日历取消验证'})).status()).toBe(200);
  await open(page,cancelled);await expect(page.getByRole('button',{name:'下载日历',exact:true})).toBeDisabled();
  await open(page,stale);let downloads=0;page.on('download',()=>downloads++);
  expect((await write(request,`/api/admin/activities/${stale.id}/cancel`,{reason:'点击前取消验证'})).status()).toBe(200);
  await page.getByRole('button',{name:'下载日历',exact:true}).click();await expect(page.locator('.ant-alert-error')).toContainText('活动已取消');
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  expect(downloads).toBe(0);await page.getByRole('button',{name:'刷新详情',exact:true}).click();
  await expect(page.getByRole('button',{name:'下载日历',exact:true})).toBeDisabled();await expect(page.getByTestId('activity-cancellation-notice')).toContainText('点击前取消验证');
});

test('网络失败手动重试，处理中防重复请求和下载',async({page,request},info)=>{
  await admin(request);const activity=await create(request,info);await open(page,activity);
  const pattern=`**/api/activities/${activity.id}`;
  await page.route(pattern,route=>route.abort('failed'));await page.getByRole('button',{name:'下载日历',exact:true}).click();
  await expect(page.locator('.ant-alert-error')).toContainText('暂时无法连接');await page.unroute(pattern);
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  let release!:()=>void,arrived!:()=>void,count=0;
  const held=new Promise<void>(resolve=>{release=resolve;}),fetched=new Promise<void>(resolve=>{arrived=resolve;});
  await page.route(pattern,async route=>{count++;const response=await route.fetch();arrived();await held;await route.fulfill({response});});
  try {
    const saved=page.waitForEvent('download');const button=page.getByRole('button',{name:'下载日历',exact:true});
    await button.click();await fetched;await expect(button).toBeDisabled();
    // Resolve the current button after error feedback reflows on narrow screens.
    await button.click({force:true});expect(count).toBe(1);
    release();await readCalendar(await saved,activity,new URL(page.url()).origin);
  } finally {release();await page.unroute(pattern);}
});

test('下载读取早于报名完成时，仅导出快照且不覆盖新报名状态',async({page,request},info)=>{
  await admin(request);const activity=await create(request,info),user=await account(request);await login(page,user.username);await open(page,activity);
  let release!:()=>void,arrived!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;}),fetched=new Promise<void>(resolve=>{arrived=resolve;});
  const pattern=`**/api/activities/${activity.id}`;
  await page.route(pattern,async route=>{const response=await route.fetch();expect((await response.json()).registrationStatus).toBeNull();arrived();await held;await route.fulfill({response});});
  try {
    const saved=page.waitForEvent('download');await page.getByRole('button',{name:'下载日历',exact:true}).click();await fetched;
    await page.getByRole('button',{name:'立即报名',exact:true}).click();await expect(page.getByRole('heading',{name:'你的名额已确认',exact:true})).toBeVisible();
    release();await readCalendar(await saved,activity,new URL(page.url()).origin);
    await expect(page.getByRole('heading',{name:'你的名额已确认',exact:true})).toBeVisible();
  } finally {release();await page.unroute(pattern);}
});

for(const destination of ['leave','activity','same-account','different-account'] as const) for(const outcome of ['success','failure'] as const)
test(`日历读取迟到${outcome}在${destination}后不下载或显示旧错误`,async({page,request},info)=>{
  await admin(request);const activity=await create(request,info),other=destination==='activity'?await create(request,info):null;
  const user=destination.includes('account')?await account(request):null;
  if(user) await login(page,user.username);await open(page,activity);
  let arrived!:()=>void,release!:()=>void,done!:()=>void,intercepted=false,downloads=0,delivered=false,cancelled=false;
  const fetched=new Promise<void>(resolve=>{arrived=resolve;}),held=new Promise<void>(resolve=>{release=resolve;}),completed=new Promise<void>(resolve=>{done=resolve;});
  page.on('download',()=>downloads++);const pattern=`**/api/activities/${activity.id}`;
  await page.route(pattern,async route=>{
    if(intercepted) return route.continue();intercepted=true;
    const original=route.request();page.on('requestfailed',failed=>{if(failed===original) cancelled=true;});
    const response=await route.fetch();expect(response.status()).toBe(200);arrived();await held;
    try {
      if(outcome==='success') await route.fulfill({response});else await route.abort('failed');delivered=true;
    } catch(error) {if(!/closed|cancel|abort|handled/i.test(String(error))) throw error;} finally {done();}
  });
  try {
    await page.getByRole('button',{name:'下载日历',exact:true}).click();await fetched;
    if(user) {await logout(page);await login(page,destination==='same-account'?user.username:'admin');}
    if(other) await open(page,other);else {await page.goto('/activities');await expect(page.getByRole('heading',{name:'发现活动',exact:true})).toBeVisible();}
    release();await completed;expect(delivered||cancelled).toBe(true);
    await expect(page.locator('.ant-alert-error')).toHaveCount(0);expect(downloads).toBe(0);
    if(user) {await expect(page.getByRole('button',{name:/账号菜单/})).toBeVisible();expect((await page.request.get('/api/auth/me')).status()).toBe(200);}
    await page.unroute(pattern);await open(page,activity);await download(page,activity);expect(downloads).toBe(1);
  } finally {release();await page.unroute(pattern);}
});
