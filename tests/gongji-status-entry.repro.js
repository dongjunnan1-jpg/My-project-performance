const { chromium } = require('playwright');
const fs=require('fs');
const DIR='/Users/helium/Library/Mobile Documents/com~apple~CloudDocs/题库/总库/事业单位总库';
const FILES=fs.readdirSync(DIR).filter(f=>/^事业单位_.*\.json$/.test(f)).sort().map(f=>DIR+'/'+f);
const cnt=t=>{const m=String(t).match(/共\s*([\d,]+)\s*题/);return m?+m[1].replace(/,/g,''):-1;};
const T=async()=>cnt(await p.evaluate(()=>document.body.innerText));
let p;
(async()=>{
  const b=await chromium.launch({channel:'chrome'});
  p=await b.newPage({viewport:{width:1440,height:1000}});
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto('file:///Users/helium/Library/Mobile%20Documents/com~apple~CloudDocs/我的程序/My%20project-performance/index.html');
  await p.waitForTimeout(1500);
  await p.setInputFiles('#fileInput', FILES);
  await p.waitForTimeout(3000);
  await p.evaluate(()=>switchZone('gk')); await p.waitForTimeout(600);
  await p.evaluate(()=>switchZone('sy')); await p.waitForTimeout(2500);

  const opts=async()=>p.evaluate(()=>[...document.getElementById('statusFilter').options].map(o=>o.value+'|'+o.textContent));
  console.log('① 状态下拉:', JSON.stringify((await opts()).slice(0,4)), '| 题数', await T());

  await p.selectOption('#statusFilter','__gongji__'); await p.waitForTimeout(1800);
  console.log('② 选公基 → 题数', await T(), '| status=', await p.evaluate(()=>filterState.status),
    '| source=', await p.evaluate(()=>filterState.source), '| 来源框=', await p.evaluate(()=>document.getElementById('sourceFilter').value));

  await p.evaluate(()=>{const s=document.getElementById('moduleFilter');s.value='判断推理';s.dispatchEvent(new Event('change',{bubbles:true}));});
  await p.waitForTimeout(1500);
  console.log('③ 叠模块判断推理 → 题数', await T(), '| 状态下拉值=', await p.evaluate(()=>document.getElementById('statusFilter').value));

  await p.selectOption('#statusFilter','wrong'); await p.waitForTimeout(1500);
  console.log('④ 选「只显示错题」→ 题数', await T(), '| status=', await p.evaluate(()=>filterState.status),
    '| source=', await p.evaluate(()=>filterState.source), '| 来源框=', JSON.stringify(await p.evaluate(()=>document.getElementById('sourceFilter').value)));

  await p.selectOption('#statusFilter','__gongji__'); await p.waitForTimeout(1500);
  console.log('⑤ 再选公基 → 题数', await T());

  await p.reload(); await p.waitForTimeout(4500);
  console.log('⑥ 刷新后 → 题数', await T(), '| 状态值=', await p.evaluate(()=>document.getElementById('statusFilter').value),
    '| 项存在=', await p.evaluate(()=>[...document.getElementById('statusFilter').options].some(o=>o.value==='__gongji__')));

  await p.evaluate(()=>switchZone('gk')); await p.waitForTimeout(1200);
  console.log('⑦ 行测区有公基项?', await p.evaluate(()=>[...document.getElementById('statusFilter').options].some(o=>o.value==='__gongji__')));
  await p.evaluate(()=>switchZone('sy')); await p.waitForTimeout(2200);
  console.log('⑧ 回事业单位 → 题数', await T(), '| 项存在=', await p.evaluate(()=>[...document.getElementById('statusFilter').options].some(o=>o.value==='__gongji__')),
    '| 只一个?', await p.evaluate(()=>[...document.getElementById('statusFilter').options].filter(o=>o.value==='__gongji__').length));

  await p.evaluate(()=>clearFilters()); await p.waitForTimeout(1500);
  console.log('⑨ 清除筛选 → 题数', await T(), '| 状态值=', await p.evaluate(()=>document.getElementById('statusFilter').value));

  await p.selectOption('#statusFilter','__gongji__'); await p.waitForTimeout(1600);
  await p.screenshot({path:'/tmp/gongji-status.png'});
  console.log('页面异常:', errs.length?errs.join(' | '):'无');
  await b.close();
})();
