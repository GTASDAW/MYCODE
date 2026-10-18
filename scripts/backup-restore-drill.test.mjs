import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {test} from 'node:test';
import {RestoreDrillApi,restoreChildEnvironment} from './backup-restore-drill.mjs';

test('real HTTP rehearsal login sends the Session cookie created by its immediately preceding CSRF read',async()=>{
  const writes=[];
  const server=createServer((request,response)=>{
    response.setHeader('Content-Type','application/json');
    if(request.url==='/api/auth/csrf') {
      if(!request.headers.cookie) response.setHeader('Set-Cookie','GATHER_RESTORE=anonymous; HttpOnly; Path=/');
      response.end(JSON.stringify({headerName:'X-CSRF-TOKEN',token:'trusted-csrf'}));return;
    }
    writes.push({cookie:request.headers.cookie,csrf:request.headers['x-csrf-token']});
    if(!['GATHER_RESTORE=anonymous','GATHER_RESTORE=authenticated'].includes(request.headers.cookie)||request.headers['x-csrf-token']!=='trusted-csrf') {
      response.writeHead(403).end('{}');return;
    }
    response.setHeader('Set-Cookie','GATHER_RESTORE=authenticated; HttpOnly; Path=/');response.end('{"id":1}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const api=new RestoreDrillApi(`http://127.0.0.1:${server.address().port}`);
    await api.login('local-user','input-is-not-logged');await api.call('/api/me/profile',{method:'PATCH',data:{displayName:'本人'}});
    assert.deepEqual(writes,[{cookie:'GATHER_RESTORE=anonymous',csrf:'trusted-csrf'},{cookie:'GATHER_RESTORE=authenticated',csrf:'trusted-csrf'}]);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('rehearsal application environment removes inherited connection/profile and JVM overrides',()=>{
  const keys=['SPRING_APPLICATION_JSON','DB_URL','SERVER_PORT','JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','MYSQL_PWD'];
  const before=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  try {
    for(const key of keys) process.env[key]='must-not-reach-restored-app';
    const environment=restoreChildEnvironment({DB_URL:'jdbc:mysql://127.0.0.1:33418/dedicated',SERVER_ADDRESS:'127.0.0.1'});
    assert.equal(environment.DB_URL,'jdbc:mysql://127.0.0.1:33418/dedicated');assert.equal(environment.SERVER_ADDRESS,'127.0.0.1');
    for(const key of keys.filter(key=>key!=='DB_URL')) assert.equal(environment[key],undefined);
  } finally {for(const key of keys) {if(before[key]===undefined) delete process.env[key];else process.env[key]=before[key];}}
});

test('rehearsal HTTP failures expose only the status rather than a response body or credentials',async()=>{
  const secret='private-database-and-cookie-details';
  const server=createServer((_,response)=>response.writeHead(503,{'Content-Type':'application/json'}).end(JSON.stringify({message:secret})));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const api=new RestoreDrillApi(`http://127.0.0.1:${server.address().port}`);
    await assert.rejects(api.call('/api/health'),error=>error.message.includes('503')&&!error.message.includes(secret));
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
