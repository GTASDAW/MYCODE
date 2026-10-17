import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import mysql from 'mysql2/promise';
import {test,expect,type APIRequestContext,type Page,type TestInfo} from '@playwright/test';
import {trackFixture,recordFixtureId,trackFavorite,trackAccount,recordAccountId,databaseConfig,verifyDatabase} from '../scripts/e2e-cleanup.mjs';

test.use({trace:'off'});
async function write(request:APIRequestContext,path:string,method='POST',data?:unknown) {
  const csrf=await (await request.get('/api/auth/csrf')).json();
  return request.fetch(path,{method,headers:{[csrf.headerName]:csrf.token},data});
}
async function loginApi(request:APIRequestContext,name='admin') {
  const csrf=await (await request.get('/api/auth/csrf')).json();
  const result=await request.post('/api/auth/login',{headers:{[csrf.headerName]:csrf.token},form:{username:name,password:name==='admin'?'Admin123!':'Demo123!'}});
  expect(result.status()).toBe(200); return result.json();
}
async function login(page:Page,name='demo') {
  await page.goto('/login');
  await page.getByLabel('账号',{exact:true}).fill(name);
  await page.getByLabel('密码',{exact:true}).fill(name==='admin'?'Admin123!':'Demo123!');
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('button',{name:/账号菜单/})).toBeVisible();
}
async function account(request:APIRequestContext) {
  const intent=trackAccount();
  const response=await write(request,'/api/auth/register','POST',{username:intent.username,password:'Demo123!',displayName:intent.displayName});
  expect(response.status()).toBe(201);
  const user=await response.json();recordAccountId(intent.key,user.id);return user;
}
async function logout(page:Page) {
  await page.getByRole('button',{name:/账号菜单/}).click();
  await page.getByRole('menuitem',{name:/退出登录/}).click();
  await expect(page.getByRole('button',{name:'登录 / 体验',exact:true})).toBeVisible();
}
async function create(request:APIRequestContext,info:TestInfo,started=false) {
  const intent=trackFixture(`收藏 ${info.project.name} ${randomUUID().slice(0,8)}`,'收藏功能真实浏览器验证，仅清理本轮准确归属记录。');
  if(started) {
    const config=databaseConfig(); const connection=await mysql.createConnection(config);
    try {
      const manifest=JSON.parse(readFileSync(process.env.E2E_RUN_MANIFEST!,'utf8'));
      await verifyDatabase(connection,config,manifest.target);
      const me=await (await request.get('/api/auth/me')).json(); expect(me).toMatchObject({username:'admin',role:'ADMIN'});
      const [rows]=await connection.execute<any[]>('SELECT id FROM users WHERE id=? AND username=\'admin\' AND role=\'ADMIN\'',[me.id]);
      expect(rows).toHaveLength(1);
      const [result]=await connection.execute<mysql.ResultSetHeader>(
        "INSERT INTO activities(title,description,location,starts_at,capacity,registered_count,created_by,category) VALUES(?,?,?,UTC_TIMESTAMP(6)-INTERVAL 1 HOUR,2,0,?,'CULTURE')",
        [intent.title,intent.description,'收藏独立初始化场地',me.id]);
      recordFixtureId(intent.key,result.insertId); return {id:result.insertId,title:intent.title};
    } finally {await connection.end();}
  }
  const result=await write(request,'/api/admin/activities','POST',{title:intent.title,description:intent.description,location:'收藏场地',category:'TECHNOLOGY',capacity:2,
    startsAt:new Date(Date.now()+48*3600000).toISOString()});
  expect(result.status()).toBe(201); const activity=await result.json();recordFixtureId(intent.key,activity.id);return activity;
}
async function collect(request:APIRequestContext,userId:number,id:number) {
  trackFavorite(userId,id); expect((await write(request,`/api/me/favorites/${id}`)).status()).toBe(200);
}
async function loaded(page:Page) {
  await expect(page.getByRole('heading',{name:'我的收藏',exact:true})).toBeVisible();
  await expect(page.getByText('还没有收藏活动',{exact:true}).or(page.locator('[data-testid^="favorite-"]').first())).toBeVisible();
}
async function capture(page:Page,info:TestInfo,name:string) {
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBeTruthy();
  const path=info.outputPath(`${name}.png`);await page.screenshot({path,fullPage:true});await info.attach(name,{path,contentType:'image/png'});
}

test('详情登录返回保留分类来源，收藏与取消、个人入口及空结果可用',async({page,request},info)=>{
  await loginApi(request);const activity=await create(request,info);const user=await account(request);
  const from='/activities?category=TECHNOLOGY&pageSize=20';
  const detail=`/activities/${activity.id}?${new URLSearchParams({from})}`;
  await page.goto(detail);
  await page.getByRole('button',{name:'登录后收藏',exact:true}).click();
  await page.getByLabel('账号',{exact:true}).fill(user.username);await page.getByLabel('密码',{exact:true}).fill('Demo123!');
  await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page).toHaveURL(new RegExp(`/activities/${activity.id}\\?`));
  const me=await (await page.request.get('/api/auth/me')).json();trackFavorite(me.id,activity.id);
  await page.getByRole('button',{name:'收藏活动',exact:true}).click();await expect(page.getByRole('button',{name:'取消收藏',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('link',{name:'返回活动列表',exact:true})).toHaveAttribute('href',from);
  await page.goto('/my-favorites');await loaded(page);await expect(page.getByTestId(`favorite-${activity.id}`)).toContainText('技术交流');
  await capture(page,info,'favorites-list');
  await page.getByTestId(`favorite-${activity.id}`).getByRole('button',{name:'取消收藏',exact:true}).click();
  await expect(page.getByText('还没有收藏活动',{exact:true})).toBeVisible();
});

test('十一条分页、刷新历史与详情返回保留条件，末页取消自动replace，开始和取消活动仍保留',async({page,request},info)=>{
  await loginApi(request); const activities=[];const user=await account(request);
  for(let n=0;n<11;n++) activities.push(await create(request,info,n===0));
  expect((await write(request,`/api/admin/activities/${activities[1].id}/cancel`,'POST',{reason:'收藏取消活动验证'})).status()).toBe(200);
  await login(page,user.username);const me=await (await page.request.get('/api/auth/me')).json();
  for(const activity of activities) await collect(page.request,me.id,activity.id);
  await page.goto('/my-favorites?page=2');await loaded(page);
  await expect(page.locator('[data-testid^="favorite-"]')).toHaveCount(1);
  await expect(page.getByTestId(`favorite-${activities[0].id}`)).toContainText('已开始');
  await page.getByRole('link',{name:new RegExp(`查看${activities[0].title}的详情`)}).click();
  await page.reload();await page.getByRole('link',{name:'返回我的收藏',exact:true}).click();
  await expect(page).toHaveURL(/\/my-favorites\?page=2$/);await loaded(page);
  const history=await page.evaluate(()=>window.history.length);
  await page.getByRole('button',{name:'取消收藏',exact:true}).click();
  await expect(page).toHaveURL(/\/my-favorites$/);await expect(page.locator('[data-testid^="favorite-"]')).toHaveCount(10);
  await expect.poll(()=>page.evaluate(()=>window.history.length)).toBe(history);
  await expect(page.getByTestId(`favorite-${activities[1].id}`)).toContainText('收藏取消活动验证');
  await page.getByRole('button',{name:'刷新收藏',exact:true}).click();await loaded(page);
  await capture(page,info,'favorites-pagination');
  await page.goto('/my-favorites?page=0001&pageSize=020&userId=999');await expect(page).toHaveURL(/\/my-favorites\?pageSize=20$/);await loaded(page);
});

test('收藏状态读取失败不阻断详情，失败提交和列表读取可手动恢复',async({page,request},info)=>{
  await loginApi(request); const activity=await create(request,info);const user=await account(request);await login(page,user.username);
  await page.route(`**/api/me/favorites/${activity.id}`,route=>route.abort('failed'));
  await page.goto(`/activities/${activity.id}`);
  await expect(page.getByRole('heading',{name:activity.title,exact:true})).toBeVisible();
  await expect(page.getByText('收藏状态暂时不可用',{exact:true})).toBeVisible();
  await page.unroute(`**/api/me/favorites/${activity.id}`);await page.getByRole('button',{name:'重试收藏状态',exact:true}).click();
  await expect(page.getByRole('button',{name:'收藏活动',exact:true})).toBeEnabled();
  const me=await (await page.request.get('/api/auth/me')).json();trackFavorite(me.id,activity.id);
  await page.route(`**/api/me/favorites/${activity.id}`,route=>route.request().method()==='POST'?route.abort('failed'):route.continue());
  await page.getByRole('button',{name:'收藏活动',exact:true}).click();await expect(page.locator('.ant-alert-error')).toContainText('暂时无法连接');
  await page.unroute(`**/api/me/favorites/${activity.id}`);await page.getByRole('button',{name:'收藏活动',exact:true}).click();
  await expect(page.getByRole('button',{name:'取消收藏',exact:true})).toBeVisible();
  await page.route('**/api/me/favorites?**',route=>route.abort('failed'));await page.goto('/my-favorites');
  await expect(page.getByRole('button',{name:'重新加载',exact:true})).toBeVisible();
  await page.unroute('**/api/me/favorites?**');await page.getByRole('button',{name:'重新加载',exact:true}).click();await loaded(page);
});

test('匿名直达收藏页进入登录且不请求私人收藏数据',async({page})=>{
  let calls=0;page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/me/favorites')) calls++;});
  await page.goto('/my-favorites?page=2');await expect(page.getByRole('heading',{name:'欢迎来到集会',exact:true})).toBeVisible();
  expect(calls).toBe(0);
});

for(const operation of ['read','write'] as const) for(const result of ['success','rejected'] as const) for(const identity of ['same','different'] as const)
test(`收藏${operation}迟到${result}在${identity}账号重登后不覆盖页面或退出新会话`,async({page,request},info)=>{
  await loginApi(request);const activity=await create(request,info);const user=await account(request);await login(page,user.username);
  const me=await (await page.request.get('/api/auth/me')).json();trackFavorite(me.id,activity.id);
  if(operation==='read') await collect(page.request,me.id,activity.id);
  await page.goto(operation==='read'?'/my-favorites':`/activities/${activity.id}`);
  if(operation==='read') await loaded(page); else await expect(page.getByRole('button',{name:'收藏活动',exact:true})).toBeEnabled();
  let arrived!:()=>void,release!:()=>void,done!:()=>void;
  const fetched=new Promise<void>(resolve=>{arrived=resolve;}),held=new Promise<void>(resolve=>{release=resolve;}),completed=new Promise<void>(resolve=>{done=resolve;});
  let intercepted=false; let lateStatus:number|undefined;
  let delivered=false, cancelled=false;
  const pattern=operation==='read'?'**/api/me/favorites?**':`**/api/me/favorites/${activity.id}`;
  await page.route(pattern,async route=>{
    const expected=operation==='read'?'GET':'POST';
    if(intercepted||route.request().method()!==expected) return route.continue();
    intercepted=true;
    const original=route.request();
    page.on('requestfailed',failed=>{if(failed===original) cancelled=true;});
    const originalHeaders=await route.request().allHeaders();
    let response=result==='success'?await route.fetch():null;
    arrived();await held;
    try {
      // A browser-context API fetch would mutate the NEW browser cookie jar
      // while reproducing the OLD rejected request. Use the isolated request fixture.
      response??=await request.fetch(original.url(),{method:original.method(),headers:originalHeaders});lateStatus=response.status();
      expect(lateStatus).toBe(result==='success'?200:operation==='read'?401:403);
      await route.fulfill({response});delivered=true;
    } catch(error) {
      // Leaving cancels fetch; a cancelled browser request may no longer accept its real response.
      if(!/closed|cancel|abort|handled/i.test(String(error))) throw error;
    } finally {done();}
  });
  try {
    if(operation==='read') await page.getByRole('button',{name:'刷新收藏',exact:true}).click();
    else await page.getByRole('button',{name:'收藏活动',exact:true}).click();
    await fetched;await logout(page);await login(page,identity==='same'?user.username:'admin');
    if(identity==='same') expect((await write(page.request,`/api/me/favorites/${activity.id}`,'DELETE')).status()).toBe(200);
    await page.goto(operation==='read'?'/my-favorites':`/activities/${activity.id}`);
    if(operation==='read') {await loaded(page);await expect(page.getByText('还没有收藏活动',{exact:true})).toBeVisible();}
    else await expect(page.getByRole('button',{name:'收藏活动',exact:true})).toBeEnabled();
    release();await completed;
    await expect(page.getByRole('button',{name:/账号菜单/})).toBeVisible();
    expect((await page.request.get('/api/auth/me')).status()).toBe(200);
    if(operation==='read') await expect(page.locator('[data-testid^="favorite-"]')).toHaveCount(0);
    else await expect(page.getByRole('button',{name:'收藏活动',exact:true})).toBeEnabled();
    await expect(page.locator('.ant-alert-error')).toHaveCount(0);
    expect(lateStatus).toBeDefined();
    expect(delivered||cancelled).toBe(true);
  } finally {release();await page.unroute(pattern);}
});
