import {randomBytes,randomUUID} from 'node:crypto';
import {crc32,deflateSync} from 'node:zlib';
import {test,expect,type APIRequestContext,type Page,type TestInfo} from '@playwright/test';
import {trackFixture,recordFixtureId,trackAccount,recordAccountId} from '../scripts/e2e-cleanup.mjs';

test.use({trace:'off'});
function png(red:number,large=false) {
  const width=large?1024:480,height=large?512:270;
  const chunk=(name:string,data:Buffer)=>{const type=Buffer.from(name),size=Buffer.alloc(4),sum=Buffer.alloc(4);
    size.writeUInt32BE(data.length);sum.writeUInt32BE(crc32(Buffer.concat([type,data])));return Buffer.concat([size,type,data,sum]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const pixels=large?randomBytes(width*height*3):Buffer.alloc(width*height*3);
  if(!large) for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const index=(y*width+x)*3;pixels[index]=red;pixels[index+1]=80+Math.floor(y/height*120);pixels[index+2]=200+Math.floor(x/width*50);
  }
  const rows=Buffer.alloc((width*3+1)*height);
  for(let y=0;y<height;y++) pixels.copy(rows,y*(width*3+1)+1,y*width*3,(y+1)*width*3);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
const firstImage=png(24),secondImage=png(140);
async function csrf(request:APIRequestContext) {const token=await (await request.get('/api/auth/csrf')).json();return {[token.headerName]:token.token};}
async function loginApi(request:APIRequestContext) {
  expect((await request.post('/api/auth/login',{headers:await csrf(request),form:{username:'admin',password:'Admin123!'}})).status()).toBe(200);
}
async function login(page:Page,name='admin') {
  await page.goto('/login');await page.getByLabel('账号',{exact:true}).fill(name);await page.getByLabel('密码',{exact:true}).fill(name==='admin'?'Admin123!':'Demo123!');
  await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('button',{name:/账号菜单/})).toBeVisible();
}
async function logout(page:Page) {
  await page.getByRole('button',{name:/账号菜单/}).click();await page.getByRole('menuitem',{name:/退出登录/}).click();
  await expect(page.getByRole('button',{name:'登录 / 体验',exact:true})).toBeVisible();
}
async function create(request:APIRequestContext,info:TestInfo) {
  await loginApi(request);const intent=trackFixture(`活动封面 ${info.project.name} ${randomUUID().slice(0,8)}`,'活动封面独立浏览器测试');
  const response=await request.post('/api/admin/activities',{headers:await csrf(request),data:{title:intent.title,description:intent.description,
    location:'封面验证会场',startsAt:new Date(Date.now()+48*3600000).toISOString(),capacity:3,category:'TECHNOLOGY'}});
  expect(response.status()).toBe(201);const activity=await response.json();recordFixtureId(intent.key,activity.id);return activity;
}
async function openEditor(page:Page,activity:any) {
  await page.goto(`/admin/activities/${activity.id}/edit`);await expect(page.getByRole('heading',{name:'编辑活动',exact:true})).toBeVisible();
  await expect(page.getByLabel('选择活动封面',{exact:true})).toBeVisible();
}
async function select(page:Page,buffer=firstImage) {
  await page.getByLabel('选择活动封面',{exact:true}).setInputFiles({name:'cover.png',mimeType:'image/png',buffer});
  await expect(page.getByRole('img',{name:'待上传活动封面',exact:true})).toBeVisible();
}
async function upload(page:Page,buffer=firstImage) {
  await select(page,buffer);await page.getByRole('button',{name:'上传封面',exact:true}).click();await expect(page.getByRole('status')).toContainText('封面已保存');
}

test('上传、更换、移除持久化，公开列表与详情展示，基本信息草稿保留且审计可追溯',async({page,request},info)=>{
  const activity=await create(request,info);await login(page);await openEditor(page,activity);
  const originalTitle=await page.getByLabel('活动标题',{exact:true}).inputValue();await page.getByLabel('活动标题',{exact:true}).fill('尚未保存的标题草稿');
  await upload(page);await expect(page.getByLabel('活动标题',{exact:true})).toHaveValue('尚未保存的标题草稿');
  const first=await (await request.get(`/api/activities/${activity.id}`)).json();expect(first.coverUrl).toMatch(/cover\?v=[a-f0-9]{64}$/);
  const image=await request.get(first.coverUrl);expect(image.status()).toBe(200);expect(image.headers()['content-type']).toContain('image/jpeg');
  expect(image.headers()['x-content-type-options']).toBe('nosniff');expect(image.headers()['cache-control']).toContain('no-cache');
  expect((await image.body()).subarray(0,3)).toEqual(Buffer.from([255,216,255]));
  if(process.env.REDIS_TEST_A_URL || process.env.REDIS_TEST_B_URL) {
    const replicas=[process.env.REDIS_TEST_A_URL,process.env.REDIS_TEST_B_URL];
    expect(replicas).toEqual(['http://127.0.0.1:19081','http://127.0.0.1:19082']);
    for(const replica of replicas) {
      const shared=await request.get(`${replica}${first.coverUrl}`);expect(shared.status()).toBe(200);
      expect(shared.headers().etag).toBe(image.headers().etag);expect(await shared.body()).toEqual(await image.body());
    }
  }
  await page.reload();await expect(page.getByLabel('活动标题',{exact:true})).toHaveValue(originalTitle);
  await upload(page,secondImage);const second=await (await request.get(`/api/activities/${activity.id}`)).json();expect(second.coverUrl).not.toBe(first.coverUrl);
  await page.goto(`/activities/${activity.id}`);const cover=page.getByRole('img',{name:`${activity.title}的活动封面`,exact:true});
  await expect(cover).toBeVisible();await expect.poll(()=>cover.evaluate((image:HTMLImageElement)=>image.naturalWidth)).toBeGreaterThan(0);
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  const shot=info.outputPath('activity-cover-detail.png');await page.screenshot({path:shot,fullPage:true});await info.attach('activity-cover-detail',{path:shot,contentType:'image/png'});
  await logout(page);await page.goto(`/activities?${new URLSearchParams({keyword:activity.title})}`);
  await expect(page.locator(`[data-activity-id="${activity.id}"] img`)).toHaveAttribute('src',second.coverUrl);
  await login(page);await openEditor(page,activity);await page.getByRole('button',{name:'移除封面',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('封面已移除');expect((await request.get(`/api/activities/${activity.id}/cover`)).status()).toBe(404);
  const logs=await (await request.get(`/api/admin/audit-logs?activityId=${activity.id}&action=EDIT`)).json();expect(logs.total).toBe(3);
  await page.goto(`/admin/audit-logs?activityId=${activity.id}&action=EDIT`);
  await page.getByRole('button',{name:/查看操作记录 .* 详情/}).first().click();await expect(page.locator('[data-audit-field="coverHash"]')).toContainText('活动封面内容编号');
});

test('非法文件与体积限制可读，合法大于1MiB封面穿过代理，超大请求返回JSON',async({page,request},info)=>{
  const activity=await create(request,info);await login(page);await openEditor(page,activity);
  const wrongType=await request.post(`/api/admin/activities/${activity.id}/cover`,{headers:await csrf(request),data:{file:'not multipart'}});
  expect(wrongType.status()).toBe(415);expect((await wrongType.json()).code).toBe('UNSUPPORTED_MEDIA_TYPE');
  const input=page.getByLabel('选择活动封面',{exact:true});
  await input.setInputFiles({name:'unsafe.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg/>')});
  await expect(page.locator('.ant-alert-error')).toContainText('PNG 或 JPEG');await expect(page.getByRole('button',{name:'上传封面',exact:true})).toBeDisabled();
  await input.setInputFiles({name:'large.png',mimeType:'image/png',buffer:Buffer.alloc(2*1024*1024+1)});
  await expect(page.locator('.ant-alert-error')).toContainText('2 MB');
  await select(page,Buffer.from('not a real png'));await page.getByRole('button',{name:'上传封面',exact:true}).click();
  await expect(page.locator('.ant-alert-error')).toBeVisible();expect((await (await request.get(`/api/activities/${activity.id}`)).json()).coverUrl).toBeNull();
  const large=png(80,true);expect(large.length).toBeGreaterThan(1024*1024);expect(large.length).toBeLessThan(2*1024*1024);
  await upload(page,large);
  const tooBig=await request.post(`/api/admin/activities/${activity.id}/cover`,{headers:await csrf(request),multipart:{file:{name:'huge.png',mimeType:'image/png',buffer:Buffer.alloc(4*1024*1024)}}});
  expect(tooBig.status()).toBe(413);expect((await tooBig.json()).code).toBe('UPLOAD_TOO_LARGE');
});

test('失败可重试、处理中不重复提交，图片读取失败可恢复，取消活动拒绝修改且普通用户无上传入口',async({page,request},info)=>{
  const activity=await create(request,info);await login(page);await openEditor(page,activity);await select(page);
  const path=`**/api/admin/activities/${activity.id}/cover`;await page.route(path,route=>route.abort('failed'));
  await page.getByRole('button',{name:'上传封面',exact:true}).click();await expect(page.locator('.ant-alert-error')).toContainText('暂时无法连接');await page.unroute(path);
  let release!:()=>void,arrived!:()=>void,count=0;const held=new Promise<void>(resolve=>{release=resolve;}),sent=new Promise<void>(resolve=>{arrived=resolve;});
  await page.route(path,async route=>{count++;const response=await route.fetch();arrived();await held;await route.fulfill({response});});
  try {const button=page.getByRole('button',{name:'上传封面',exact:true});await button.click();await sent;await expect(button).toBeDisabled();
    await button.click({force:true});expect(count).toBe(1);release();await expect(page.getByRole('status')).toContainText('封面已保存');
  } finally {release();await page.unroute(path);}
  await page.route(`**/api/activities/${activity.id}/cover?*`,route=>route.abort('failed'));
  await page.goto(`/activities/${activity.id}`);await expect(page.getByText('封面暂时无法显示',{exact:true})).toBeVisible();
  await page.unroute(`**/api/activities/${activity.id}/cover?*`);await page.getByRole('button',{name:'重新加载封面',exact:true}).click();
  await expect(page.getByRole('img',{name:`${activity.title}的活动封面`,exact:true})).toBeVisible();
  expect((await request.post(`/api/admin/activities/${activity.id}/cancel`,{headers:await csrf(request),data:{reason:'封面取消边界验证'}})).status()).toBe(200);
  await openEditor(page,activity);await expect(page.getByLabel('选择活动封面',{exact:true})).toBeDisabled();
  await logout(page);await login(page,'demo');await page.goto(`/admin/activities/${activity.id}/edit`);
  await expect(page.getByLabel('选择活动封面',{exact:true})).toHaveCount(0);
});

for(const destination of ['leave','same-account','different-account'] as const) for(const outcome of ['success','failure'] as const)
test(`封面提交迟到${outcome}在${destination}后不覆盖新页面或新身份`,async({page,request},info)=>{
  const activity=await create(request,info);
  let other:any;
  if(destination==='different-account') {
    const intent=trackAccount();const response=await request.post('/api/auth/register',{headers:await csrf(request),data:{username:intent.username,displayName:intent.displayName,password:'Demo123!'}});
    expect(response.status()).toBe(201);other=await response.json();recordAccountId(intent.key,other.id);
  }
  await login(page);await openEditor(page,activity);await select(page);
  let release!:()=>void,arrived!:()=>void,finished!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;}),sent=new Promise<void>(resolve=>{arrived=resolve;}),done=new Promise<void>(resolve=>{finished=resolve;});
  const path=`**/api/admin/activities/${activity.id}/cover`;
  await page.route(path,async route=>{const response=await route.fetch();expect(response.status()).toBe(200);arrived();await held;
    try {if(outcome==='success') await route.fulfill({response});else await route.abort('failed');}
    catch(error) {if(!/closed|handled|cancel|abort/i.test(String(error))) throw error;} finally {finished();}});
  try {
    await page.getByRole('button',{name:'上传封面',exact:true}).click();await sent;
    if(destination==='leave') {await page.getByRole('link',{name:'返回活动详情',exact:true}).click();}
    else {await logout(page);await login(page,other?.username??'admin');await page.goto('/profile');}
    release();await done;await expect(page.locator('.ant-alert-error')).toHaveCount(0);await expect(page.getByText('封面已保存',{exact:true})).toHaveCount(0);
    await expect(page.getByRole('img',{name:'待上传活动封面',exact:true})).toHaveCount(0);
    expect((await page.request.get('/api/auth/me')).status()).toBe(200);
    await page.unroute(path);
    if(!other) {await openEditor(page,activity);await expect(page.getByRole('button',{name:'上传封面',exact:true})).toBeDisabled();await upload(page,secondImage);}
  } finally {release();await page.unroute(path);}
});
