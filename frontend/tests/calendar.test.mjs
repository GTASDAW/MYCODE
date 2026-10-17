import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildActivityCalendar,calendarContentType} from '../src/activityCalendar.ts';
import {downloadFile,downloadCsv} from '../src/fileDownload.ts';

const activity={id:42,title:'技术交流',description:'欢迎参加',location:'上海会场',startsAt:'2035-01-01T16:30:59.123456Z',cancelled:false};
const generated=new Date('2034-12-30T23:59:58.123Z');
const build=(value=activity,origin='https://gather.example:8443')=>buildActivityCalendar(value,origin,generated);
const unfold=text=>text.replace(/\r\n[ \t]/g,'');

test('calendar contains one event with UTC start and canonical stable public UID, without a fabricated end',()=>{
  const result=unfold(build());
  assert(result.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:'));
  assert(result.endsWith('END:VEVENT\r\nEND:VCALENDAR\r\n'));
  assert(result.includes('UID:https://gather.example:8443/activities/42\r\n'));
  assert(result.includes('URL:https://gather.example:8443/activities/42\r\n'));
  assert(result.includes('DTSTAMP:20341230T235958Z\r\n'));
  assert(result.includes('DTSTART:20350101T163059Z\r\n'));
  assert(!/^(DTEND|DURATION|METHOD|ATTENDEE|ORGANIZER|TRIGGER|SEQUENCE):/m.test(result));
  assert(!result.includes('BEGIN:VALARM'));
  const repeated=unfold(buildActivityCalendar({...activity,title:'活动新标题'},'https://gather.example:8443',new Date('2035-01-01T00:00:00Z')));
  assert.equal(result.match(/^UID:(.*)$/m)[1],repeated.match(/^UID:(.*)$/m)[1]);
});
test('Beijing midnight and explicit UTC offsets represent the same calendar instant',()=>{
  const utc=unfold(build());
  const beijing=unfold(build({...activity,startsAt:'2035-01-02T00:30:59.123456+08:00'}));
  assert.equal(beijing,utc);
  assert(unfold(build({...activity,startsAt:'2001-01-01T00:00:00Z',closed:true})).includes('DTSTART:20010101T000000Z'));
});
test('text escapes backslashes, commas, semicolons and all newline styles without injecting properties',()=>{
  const result=unfold(build({...activity,title:'活动,;\\"😀',location:'地点\r\n第二行\r第三行\n第四行',
    description:'说明\r\nEND:VEVENT\nBEGIN:VEVENT\rATTENDEE:mailto:person@example.com'}));
  assert(result.includes('SUMMARY:活动\\,\\;\\\\"😀\r\n'));
  assert(result.includes('LOCATION:地点\\n第二行\\n第三行\\n第四行\r\n'));
  assert.equal((result.match(/^BEGIN:VEVENT\r?$/gm)||[]).length,1);
  assert.equal((result.match(/^END:VEVENT\r?$/gm)||[]).length,1);
  assert(!/^ATTENDEE:/m.test(result));
  assert(result.includes('说明\\nEND:VEVENT\\nBEGIN:VEVENT\\nATTENDEE:mailto:person@example.com'));
});
test('every physical line stays within 75 UTF-8 bytes and folding preserves Chinese and emoji exactly',async()=>{
  const title='中文😀'.repeat(60);
  const result=build({...activity,title,description:'注释🚀'.repeat(200)});
  for(const line of result.split('\r\n')) assert(Buffer.byteLength(line,'utf8')<=75);
  assert(!/[\r\n]/.test(result.replaceAll('\r\n','')));
  assert(unfold(result).includes(`SUMMARY:${title}\r\n`));
  assert(!result.includes('\uFFFD'));
  const blob=new Blob([result],{type:calendarContentType});
  assert.equal(blob.type,'text/calendar;charset=utf-8');
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer()).slice(0,3)],[66,69,71]);
  assert.equal(await blob.text(),result);
});
test('private activity fields, URL query/fragment, and list-return data never enter the calendar',()=>{
  const result=unfold(build({...activity,registrationStatus:'WAITING',userId:999,checkedInBy:'private-admin',favoritedAt:'private-time',
    from:'/my-favorites?page=2',token:'private-token'},'https://gather.example:8443/old?userId=999#private'));
  for(const secret of ['WAITING','999','private-admin','private-time','my-favorites','private-token','/old']) assert(!result.includes(secret));
  assert(result.includes('未提供结束时间'));assert(result.includes('不代表报名成功'));assert(result.includes('不会自动同步'));
});
test('cancelled events, invalid dates/IDs/origins and unsupported control or Unicode input are rejected',()=>{
  for(const value of [{...activity,cancelled:true},{...activity,id:0},{...activity,id:Number.MAX_SAFE_INTEGER+1},
    {...activity,startsAt:'invalid'},{...activity,title:'bad\u0000title'},{...activity,description:'bad\ud800'}]) assert.throws(()=>build(value));
  for(const origin of ['javascript:alert(1)','file:///tmp','https://user:secret@gather.example']) assert.throws(()=>build(activity,origin));
  assert.throws(()=>buildActivityCalendar(activity,'https://gather.example',new Date('invalid')));
});
test('the generic downloader retains the exact existing CSV export for callers and cleanup tests',()=>{
  assert.equal(downloadFile,downloadCsv);
});
