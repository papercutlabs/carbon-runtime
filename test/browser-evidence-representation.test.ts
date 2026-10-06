import test from 'node:test';import assert from 'node:assert/strict';
import { indexEvidenceRepresentation, resolveEvidenceFragment } from '../runtime/browser-evidence-representation.ts';
test('actual varied immutable bytes resolve text/comment fields/quoted rows/full image and derived chart without semantic claims', () => {
 const log=Buffer.from(Array.from({length:40000},(_,i)=>`line-${i+1}: observed-value-${i}`).join('\n'));
 const text=indexEvidenceRepresentation(log,'text/plain','incident.log');const fragment=resolveEvidenceFragment(text,{kind:'lines',start:31999,end:32001},2,2,10);assert.equal(fragment.kind,'text');assert.equal(fragment.lines![2].text,'line-31999: observed-value-31998');assert.equal(fragment.total,40000);
 const comments=Buffer.from(JSON.stringify({startAt:1,total:3,comments:[{id:'comment-v2',body:{type:'doc',content:[{type:'paragraph',text:'Original body retained'}]},updated:'2026-10-07T01:02:03Z'}]}));
 const json=indexEvidenceRepresentation(comments,'application/json','comments.json'),field=resolveEvidenceFragment(json,{kind:'field',pointer:'/comments/0/body/content/0/text'},0,0,4);assert.equal(field.value,'Original body retained');assert.equal(json.fields && typeof json.fields==='object' && !Array.isArray(json.fields) ? json.fields.total : null,3);
 const csv=indexEvidenceRepresentation(Buffer.from('id,unit,value\r\nalpha,seconds,58\r\n"beta,quoted",minutes,27\r\n'),'text/csv','observations.csv');assert.deepEqual(resolveEvidenceFragment(csv,{kind:'rows',start:2,end:2},1,0,2).rows![1].cells,['beta,quoted','minutes','27']);
 const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l8kAAAAASUVORK5CYII=','base64');
 const full=indexEvidenceRepresentation(image,'image/png','screenshot.png'),region=resolveEvidenceFragment(full,{kind:'region',x:0,y:0,width:.5,height:.5},0,0,1);assert.equal(region.kind,'image');assert.equal(region.width,1);assert.equal(full.sha256,indexEvidenceRepresentation(image,'image/png','derived-chart.png').sha256,'representation indexes exact bytes; origin is trusted custody, never inferred from filename');
 assert.throws(()=>resolveEvidenceFragment(text,{kind:'lines',start:40000,end:40001},0,0,10),/outside/);assert.throws(()=>resolveEvidenceFragment(json,{kind:'field',pointer:'/comments/9/body'},0,0,10),/no such/);assert.throws(()=>resolveEvidenceFragment(full,{kind:'region',x:.8,y:0,width:.5,height:.5},0,0,1),/normalized/);
 const active=indexEvidenceRepresentation(Buffer.from('<script>throw 1</script>'),'text/html','analysis.html');assert.equal(active.kind,'file');assert.match(active.limitation!,/download/);
});

test('selected result mutations cannot poison reused representation indexes',()=>{
 const rep=indexEvidenceRepresentation(Buffer.from('id,value\nsource,7\n'),'text/csv','original.csv'),first=resolveEvidenceFragment(rep,{kind:'rows',start:1,end:1},0,0,1);first.rows![0].cells[1]='forged';first.columns![0]='forged';const next=resolveEvidenceFragment(rep,{kind:'rows',start:1,end:1},0,0,1);assert.deepEqual(next.rows![0].cells,['source','7']);assert.equal(next.columns![0],'id');
 const json=indexEvidenceRepresentation(Buffer.from('{"record":{"value":7}}'),'application/json','original.json'),field=resolveEvidenceFragment(json,{kind:'field',pointer:'/record'},0,0,1);(field.value as {value:number}).value=99;assert.equal((resolveEvidenceFragment(json,{kind:'field',pointer:'/record'},0,0,1).value as {value:number}).value,7);
});
