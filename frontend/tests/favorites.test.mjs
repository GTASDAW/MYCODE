import assert from 'node:assert/strict';
import {afterEach,test} from 'node:test';
import {favoriteListPath,parseFavoriteQuery,serializeFavoriteQuery} from '../src/favoriteQuery.ts';
import {myRegistrationDetailsPath,safeActivityDetailReturn} from '../src/activityDetailNavigation.ts';
import {safeActivityListPath} from '../src/activityDiscovery.ts';
const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;});

test('favorite URL defaults, custom sizes, limits and identity stripping are deterministic',()=>{
  assert.equal(favoriteListPath(parseFavoriteQuery('')),'/my-favorites');
  assert.deepEqual(parseFavoriteQuery('?page=0002&pageSize=020&userId=9&status=ACTIVE'),{page:2,pageSize:20});
  for(const value of ['0','-1','1e2','1.5','2147483648','Infinity','']) assert.equal(parseFavoriteQuery(`?page=${value}`).page,1);
  for(const value of ['0','101','-1','abc','10.5']) assert.equal(parseFavoriteQuery(`?pageSize=${value}`).pageSize,10);
  for(const pageSize of [1,7,10,20,50,100]) {
    const query={page:4,pageSize}; assert.deepEqual(parseFavoriteQuery(serializeFavoriteQuery(query)),query);
  }
});
test('favorite detail return stays internal without widening public-list navigation',()=>{
  const source='/my-favorites?page=2&pageSize=20';
  assert.equal(safeActivityDetailReturn(source),source);
  assert.equal(safeActivityDetailReturn('/my-favorites?page=0002&unknown=ignored'),'/my-favorites?page=2');
  assert.equal(safeActivityListPath(source),'/activities');
  const path=myRegistrationDetailsPath(42,source);
  assert.equal(new URLSearchParams(path.split('?')[1]).get('from'),source);
  for(const value of ['//evil/my-favorites','https://evil/my-favorites','/my-favorites/42','/my-favorites#bad','/my-favorites\\x','/my-favorites\n'])
    assert.equal(safeActivityDetailReturn(value),'/activities');
});
test('favorite calls use only the current-session endpoints, CSRF and cancellation, without identity or bodies',async()=>{
  const {api}=await import(`../src/api.ts?favorites=${Date.now()}`);
  const calls=[]; const controller=new AbortController();
  globalThis.fetch=async(url,options)=>{
    calls.push({url,options});
    return new Response(JSON.stringify(url.endsWith('/csrf')?{token:'sample-csrf',headerName:'X-CSRF-TOKEN'}
      :url.includes('?')?{items:[],total:0,page:2,pageSize:20}:{favorited:options.method!=='DELETE',favoritedAt:null}),{status:200});
  };
  await api.favorite(42,controller.signal);
  await api.setFavorite(42,true,controller.signal);
  await api.setFavorite(42,false,controller.signal);
  await api.favorites({page:2,pageSize:20,userId:999},controller.signal);
  const business=calls.filter(call=>!call.url.endsWith('/csrf'));
  assert.deepEqual(business.map(call=>[call.url,call.options.method??'GET']),[
    ['/api/me/favorites/42','GET'],['/api/me/favorites/42','POST'],['/api/me/favorites/42','DELETE'],['/api/me/favorites?page=2&pageSize=20','GET']]);
  for(const call of business) { assert.equal(call.options.signal,controller.signal);assert.equal(call.options.body,undefined);assert.equal(call.options.credentials,'same-origin'); }
  for(const call of business.filter(call=>['POST','DELETE'].includes(call.options.method))) assert.equal(call.options.headers.get('X-CSRF-TOKEN'),'sample-csrf');
});
