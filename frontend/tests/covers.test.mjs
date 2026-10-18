import assert from 'node:assert/strict';
import {afterEach,test} from 'node:test';
import {activityCoverMaxBytes,validateActivityCover,safeActivityCoverUrl} from '../src/activityCover.ts';
const originalFetch=globalThis.fetch;
let sequence=0;
afterEach(()=>{globalThis.fetch=originalFetch;});
const response=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});

test('cover selection accepts only PNG/JPEG, positive size and the exact 2 MiB boundary',()=>{
  for(const [name,type] of [['封面.PNG','image/png'],['photo.jpg','image/jpeg'],['photo.JPEG','image/jpeg']])
    assert.equal(validateActivityCover({name,type,size:activityCoverMaxBytes}),null);
  for(const value of [{name:'a.png',type:'image/png',size:0},{name:'a.png',type:'image/png',size:activityCoverMaxBytes+1},
    {name:'a.svg',type:'image/svg+xml',size:12},{name:'a.png',type:'image/jpeg',size:12},
    {name:'a.gif',type:'image/gif',size:12},{name:'a.png.exe',type:'image/png',size:12}])
    assert.equal(typeof validateActivityCover(value),'string');
});

test('cover image sources accept only the same activity endpoint and canonical content hash',()=>{
  const hash='a1'.repeat(32),url=`/api/activities/12/cover?v=${hash}`;
  assert.equal(safeActivityCoverUrl(12,url),url);
  for(const value of [null,undefined,'',`https://evil.example${url}`,`//evil.example${url}`,url+'\n',url+'#fragment',
    url+'&userId=99',url.replace('/12/','/13/'),url.replace(hash,hash.toUpperCase()),url.replace(hash,'a'.repeat(63))])
    assert.equal(safeActivityCoverUrl(12,value),null);
  assert.equal(safeActivityCoverUrl(0,url),null);
});

test('cover upload uses the unified CSRF client with FormData, without forcing a multipart boundary or identity',async()=>{
  const {api}=await import(`../src/api.ts?covers=${sequence++}`);
  const calls=[],controller=new AbortController(),file=new File(['PNG fixture'],'cover.png',{type:'image/png'});
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return response(200,url.endsWith('/csrf')?
    {token:'csrf-cover',headerName:'X-CSRF-TOKEN'}:{id:12,coverUrl:'/api/activities/12/cover?v='+'a'.repeat(64)});};
  const result=await api.uploadActivityCover(12,file,controller.signal);
  assert.equal(result.id,12);
  const upload=calls.find(call=>call.options.method==='POST');
  assert.equal(upload.url,'/api/admin/activities/12/cover');
  assert.equal(upload.options.signal,controller.signal);assert.equal(upload.options.credentials,'same-origin');
  assert.equal(upload.options.headers.get('X-CSRF-TOKEN'),'csrf-cover');
  assert.equal(upload.options.headers.has('Content-Type'),false);
  assert.deepEqual([...upload.options.body.keys()],['file']);assert.equal(upload.options.body.get('file').name,'cover.png');
  assert.equal(await upload.options.body.get('file').text(),'PNG fixture');
});

test('cover removal sends no identity or body and propagates structured failure and request ID',async()=>{
  const {api,ApiError}=await import(`../src/api.ts?covers=${sequence++}`);let write;
  globalThis.fetch=async(url,options)=>{
    if(url.endsWith('/csrf')) return response(200,{token:'csrf-delete',headerName:'X-CSRF-TOKEN'});
    write={url,options};return new Response(JSON.stringify({code:'ACTIVITY_CLOSED',message:'活动已开始'}),
      {status:409,headers:{'Content-Type':'application/json','X-Request-Id':'12345678-1234-1234-1234-123456789abc'}});
  };
  await assert.rejects(api.removeActivityCover(12),error=>error instanceof ApiError && error.status===409 &&
    error.requestId==='12345678-1234-1234-1234-123456789abc');
  assert.equal(write.url,'/api/admin/activities/12/cover');assert.equal(write.options.method,'DELETE');
  assert.equal(write.options.body,undefined);assert.equal(write.options.headers.get('X-CSRF-TOKEN'),'csrf-delete');
});

test('an already cancelled cover submission never fetches or refreshes CSRF',async()=>{
  const {api}=await import(`../src/api.ts?covers=${sequence++}`);const controller=new AbortController();controller.abort();
  globalThis.fetch=()=>{throw Error('Aborted upload must not send a request');};
  await assert.rejects(api.uploadActivityCover(12,new File(['x'],'x.png',{type:'image/png'}),controller.signal),{name:'AbortError'});
  await assert.rejects(api.removeActivityCover(12,controller.signal),{name:'AbortError'});
});
