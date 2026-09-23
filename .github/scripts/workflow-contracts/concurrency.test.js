const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');

for (const file of ['build-images.yaml','deploy-products.yaml','build-and-deploy.yaml']) {
  const source=readFileSync(resolve(__dirname,'../../workflows',file),'utf8');
  const groups=[...source.matchAll(/^      group: (.+)$/gm)].map(match=>match[1]);
  test(`${file} separates events and environment scopes while preserving same-scope cancellation`,()=>{
    assert.match(source,/concurrency_scope:\n(?:.*\n){2}\s+default: "default"/);
    assert.equal(groups.length,file==='build-and-deploy.yaml'?2:1);
    const render=(group,event,scope,run=1)=>group.replace(/\$\{\{(.*?)\}\}/g,(_,expression)=>
      Function('github','inputs',`return (${expression});`)(
        {workflow:'CI',event_name:event,ref:'refs/heads/main',run_id:run},
        {concurrency_scope:scope,helm_release:''}));
    for(const group of groups){
      assert.notEqual(render(group,'push','nonprod'),render(group,'workflow_dispatch','prod'));
      assert.notEqual(render(group,'workflow_dispatch','dev'),render(group,'workflow_dispatch','prod'));
      assert.notEqual(render(group,'push','default'),render(group,'workflow_dispatch','default'));
      assert.equal(render(group,'push','nonprod',1),render(group,'push','nonprod',2));
    }
    if(groups.length===2)assert.notEqual(render(groups[0],'workflow_dispatch','prod'),render(groups[1],'workflow_dispatch','prod'));
  });
}
