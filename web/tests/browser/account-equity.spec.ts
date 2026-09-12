import { test, expect, type Page } from '@playwright/test';
import { RETURN_METHOD, equityKey, type EquityRecord } from '../../src/lib/account-equity';

const one:EquityRecord={account_ref:'11111111-1111-4111-8111-111111111111',broker:'KIS',account_type:'paper',currency:'KRW',scope:'account-total-assets',date_timezone:'Asia/Seoul',
  date:'2026-09-01',collected_at:'2026-09-01T01:00:00.000Z',calculated_at:'2026-09-01T02:00:00.000Z',received_at:'2026-09-01T03:00:00.000Z',valued_at:null,
  equity:'1000000.12345678',cash:null,stock_value:null,return_index:null,return_status:'insufficient_samples',return_method:null,return_base_at:null,source:'KIS_ACCOUNT_EQUITY'};
async function prepare(page:Page, points:EquityRecord[]=[one], second?:EquityRecord, holdings:unknown[] = []) {
  const latest=points.at(-1)!;
  await page.route('**/api/**', async route=>{
    const url=new URL(route.request().url());
    let result:unknown={ok:true};
    if(url.pathname==='/api/auth/me')result={user:{email:'qa@example.com'}};
    if(url.pathname==='/api/holdings')result={holdings,performance:[]};
    if(url.pathname==='/api/quotes')result={quotes:{},usdKrw:null,jpyKrw:null,asOf:new Date().toISOString()};
    if(url.pathname==='/api/integration-token')result={active:false};
    if(url.pathname==='/api/manual-trades')result={trades:[],summary:[],next:null};
    if(url.pathname==='/api/briefing-status')result={collections:[],delivery:null,run:null,emailEnabled:false};
    if(url.pathname==='/api/account-equity')result=url.search ? {points:second && url.searchParams.get('account_ref')===second.account_ref ? [second] : points.filter(p=>p.date>=(url.searchParams.get('from')??'')),next:null} : {series:[latest,...(second?[second]:[])]};
    await route.fulfill({json:result});
  });
  await page.goto('/portfolio');
  await expect(page.getByRole('heading',{name:'연동 계좌 자산',exact:true})).toBeVisible();
  await expect(page.getByLabel('계좌 선택').locator(`option[value="series:${equityKey(latest)}"]`)).toHaveCount(1);
  await page.getByLabel('계좌 선택').selectOption(`series:${equityKey(latest)}`);
  await page.getByRole('button',{name:'전체 기간',exact:true}).click();
  await expect(page.locator('.pf-equity-svg')).toBeVisible();
}

test('현금 분해 없는 한 점·미확인 수익률·모바일 레이아웃과 접기',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await prepare(page);
  await expect(page.locator('.pf-equity-summary')).toContainText('1,000,000.12345678원');
  await expect(page.locator('.pf-equity-summary')).toContainText('미확인');
  await expect(page.locator('.pf-equity-svg circle')).toHaveCount(1);
  await expect(page.getByText(/확인된 값이 한 점/)).toBeVisible();
  await expect(page.locator('.pf-fold').first()).not.toHaveAttribute('open');
  await page.locator('.pf-fold').last().locator('summary').click();
  await expect(page.getByLabel('종목명',{exact:true})).toBeVisible();
  await page.locator('.pf-fold').last().locator('summary').click();
  await page.locator('section[aria-labelledby="pf-equity-title"]').screenshot({path:info.outputPath('account-one-point.png')});
  await page.emulateMedia({colorScheme:'dark'});
  await page.locator('section[aria-labelledby="pf-equity-title"]').screenshot({path:info.outputPath('account-one-point-dark.png')});
  await page.getByRole('button',{name:'누적 수익률',exact:true}).click();
  await expect(page.locator('.pf-equity-svg')).toHaveCount(0);
  await expect(page.locator('.pf-equity')).not.toContainText('0.00%');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('키움 국내·미국 계열과 보유종목을 분리하고 빈 기간을 0원으로 만들지 않는다',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  const domestic:EquityRecord={...one,broker:'KIWOOM',scope:'domestic',source:'KIWOOM_KR_EQUITY',equity:'1000000',cash:'200000',stock_value:'800000'};
  const overseas:EquityRecord={...one,account_ref:'22222222-2222-4222-8222-222222222222',broker:'KIWOOM',currency:'USD',scope:'overseas',source:'KIWOOM_US_EQUITY',equity:'1500',cash:'500',stock_value:'1000'};
  const base={broker:'KIWOOM',source:'stock_trading',account_type:'paper',quantity:1,avg_price:100};
  await prepare(page,[domestic],overseas,[{...base,stock_code:'005930',stock_name:'국내 예시 종목',market:'KR'},{...base,stock_code:'AAPL',stock_name:'미국 예시 종목',market:'US'}]);
  await expect(page.getByLabel('계좌 선택').locator('option:checked')).toContainText('국내자산 KRW');
  await expect(page.locator('.pf-equity-summary')).toContainText('국내 총자산');
  await expect(page.locator('.pf-equity-summary')).toContainText('1,000,000원');
  await expect(page.locator('.pf-equity-summary')).not.toContainText('$');
  await expect(page.locator('.pf-equity')).toContainText('마지막 수집');
  await expect(page.locator('.pf-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.pf-table')).toContainText('국내 예시 종목');
  await expect(page.locator('.pf-performance')).toContainText('전체 시장 집계');
  await page.locator('section[aria-labelledby="pf-equity-title"]').screenshot({path:info.outputPath('kiwoom-domestic.png')});
  await page.getByLabel('계좌 선택').selectOption(`series:${equityKey(overseas)}`);
  await expect(page.locator('.pf-equity-summary')).toContainText('$1,500');
  await expect(page.locator('.pf-equity-summary')).not.toContainText('1,000,000');
  await expect(page.locator('.pf-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.pf-table')).toContainText('미국 예시 종목');
  await page.getByLabel('계좌 선택').selectOption('KIWOOM:paper');
  await expect(page.locator('.pf-equity-summary')).toContainText('미수집');
  await expect(page.locator('.pf-equity-svg')).toHaveCount(0);
  await expect(page.locator('.pf-table tbody tr')).toHaveCount(2);
  await page.route('**/api/account-equity?**',route=>route.fulfill({json:{points:[],next:null}}));
  await page.getByLabel('계좌 선택').selectOption(`series:${equityKey(domestic)}`);
  await expect(page.getByText('선택 기간에 수집된 기록이 없습니다.',{exact:true})).toBeVisible();
  await expect(page.locator('.pf-equity-svg')).toHaveCount(0);
  await expect(page.locator('.pf-equity-summary')).toContainText('1,000,000원');
  const layout=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth,
    overflow:[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth).map(e=>({tag:e.tagName,class:e.className,right:e.getBoundingClientRect().right})).slice(0,12)}));
  if(layout.width>layout.viewport) {
    await page.screenshot({path:info.outputPath('full-layout-failure.png'),fullPage:true});
  }
  expect(layout.width,JSON.stringify(layout)).toBeLessThanOrEqual(layout.viewport);
  expect(errors).toEqual([]);
});

test('일별 공백·기준일 변경을 연결하지 않고 통화 다른 계좌는 분리한다',async({page},info)=>{
  const verified:EquityRecord={...one,return_status:'verified',return_method:RETURN_METHOD,return_base_at:one.collected_at,return_index:'1'};
  const points=[verified,{...verified,date:'2026-09-02',return_index:'1.1',equity:'1100000'},
    {...verified,date:'2026-09-04',return_index:null,return_status:'cash_flows_unverified' as const,equity:'1200000'},
    {...verified,date:'2026-09-05',return_base_at:'2026-09-05T00:00:00Z',return_index:'1',equity:'1250000'}];
  const second={...one,account_ref:'22222222-2222-4222-8222-222222222222',broker:'KIWOOM' as const,currency:'USD' as const,scope:'overseas' as const,source:'KIWOOM_US_EQUITY' as const,equity:'0',cash:'0',stock_value:'0'};
  await prepare(page,points,second);
  await page.getByRole('button',{name:'누적 수익률',exact:true}).click();
  await expect(page.locator('.pf-equity-svg circle')).toHaveCount(3);
  const path=await page.locator('.pf-equity-svg path').getAttribute('d');
  expect(path!.match(/M/g)).toHaveLength(2);expect(path!.match(/L/g)).toHaveLength(1);
  await page.getByLabel('날짜별 값',{exact:true}).selectOption('2026-09-02');
  await expect(page.locator('.pf-equity-inspect')).toContainText('10.00%');
  await page.locator('section[aria-labelledby="pf-equity-title"]').screenshot({path:info.outputPath('account-return-gaps.png')});
  // A historical correction need not change the latest observation or its receipt timestamp.
  points[1].return_index='1.12';
  await page.getByRole('button',{name:'자산 이력 새로고침',exact:true}).click();
  await expect(page.locator('.pf-equity-inspect')).toContainText('12.00%');
  await page.getByLabel('계좌 선택').selectOption(`series:${equityKey(second)}`);
  await page.getByRole('button',{name:'전체 기간',exact:true}).click();
  await expect(page.locator('.pf-equity-summary')).toContainText('$0');
  await expect(page.locator('.pf-equity-summary')).not.toContainText('1,250,000');
  await page.getByLabel('계좌 선택').selectOption('all');
  await expect(page.locator('.pf-equity-summary')).toContainText('미수집');
  await expect(page.locator('.pf-equity-svg')).toHaveCount(0);
});

for (const broker of ['KIWOOM','KIS'] as const) test(`${broker} 원화 총자산·국내·미국 주식 상세와 공백·실패 표시`,async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  const total:EquityRecord={...one,broker,account_group_ref:'33333333-3333-4333-8333-333333333333',source:broker==='KIWOOM'?'KIWOOM_ACCOUNT_EQUITY':'KIS_ACCOUNT_EQUITY',
    equity:'250000',cash:'20000',stock_value:'230000',breakdown:{status:'verified',domestic_stock_value_krw:'100000',us_stock_value_usd:'100',us_stock_value_krw:'130000',cash_krw:'20000',usd_krw_rate:'1300',
      fx_source:broker==='KIWOOM'?'KIWOOM_USD_SELL':'KIS_USD_FIRST',observed_at:one.collected_at,source:broker==='KIWOOM'?'KIWOOM_LINKED_V1':'KIS_RECONCILED_V1',cash_scope:broker==='KIWOOM'?'separate-accounts':'account'}};
  const missing={...total,date:'2026-09-02',breakdown:undefined};
  const last={...total,date:'2026-09-03'};
  await prepare(page,[total,missing,last]);
  const summary=page.locator('.pf-equity-summary');
  await expect(summary.locator(':scope > div')).toHaveCount(4);
  await expect(summary).toContainText('250,000원');await expect(summary).toContainText('$100');
  await expect(summary.locator(':scope > div').last()).toContainText('20,000원');
  await expect(page.getByLabel('계좌 선택').locator('option:checked')).toContainText('연결 계좌 묶음 총자산');
  await page.getByRole('button',{name:'국내주식 평가액',exact:true}).click();
  await expect(page.locator('.pf-equity-svg circle')).toHaveCount(2);
  expect((await page.locator('.pf-equity-svg path').getAttribute('d'))!.match(/M/g)).toHaveLength(2);
  await expect(page.locator('.pf-equity-inspect')).toContainText('100,000원');
  await expect(page.locator('.pf-equity-inspect')).toContainText('수익률 아님');
  await page.getByRole('button',{name:'미국주식 평가액',exact:true}).click();
  await expect(page.locator('.pf-equity-inspect')).toContainText('130,000원');
  await expect(page.locator('.pf-equity')).not.toContainText('0.00%');
  await page.locator('section[aria-labelledby="pf-equity-title"]').screenshot({path:info.outputPath(`${broker.toLowerCase()}-total-detail.png`)});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.route('**/api/account-equity?**',route=>route.fulfill({status:502,json:{error:'unavailable'}}));
  await page.getByRole('button',{name:'자산 이력 새로고침',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:'이력을 불러오지 못했습니다'})).toBeVisible();
  await expect(summary).toContainText('250,000원');
  await page.route('**/api/account-equity?**',route=>route.fulfill({json:{points:[{...last,breakdown:undefined}],next:null}}));
  await page.route('**/api/account-equity',route=>route.fulfill({json:{series:[{...last,breakdown:undefined}]}}));
  await page.getByRole('button',{name:'자산 이력 새로고침',exact:true}).click();
  await expect(page.locator('.pf-equity-summary')).toContainText('미확인');
  await expect(page.locator('.pf-equity-summary')).not.toContainText('$100');
  await expect(page.locator('.pf-equity-svg')).toHaveCount(0);
  await expect(page.getByText('상세 미확인 · 이 기간의 검증된 주식 평가액이 없습니다.',{exact:true})).toBeVisible();
  await page.locator('section[aria-labelledby="pf-equity-title"]').screenshot({path:info.outputPath(`${broker.toLowerCase()}-detail-unverified.png`)});
  expect(errors).toEqual([]);
});
