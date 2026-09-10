import { test, expect, type Page } from '@playwright/test';
import { RETURN_METHOD, equityKey, type EquityRecord } from '../../src/lib/account-equity';

const one:EquityRecord={account_ref:'11111111-1111-4111-8111-111111111111',broker:'KIS',account_type:'paper',currency:'KRW',scope:'account-total-assets',date_timezone:'Asia/Seoul',
  date:'2026-09-01',collected_at:'2026-09-01T01:00:00.000Z',calculated_at:'2026-09-01T02:00:00.000Z',received_at:'2026-09-01T03:00:00.000Z',valued_at:null,
  equity:'1000000.12345678',cash:null,stock_value:null,return_index:null,return_status:'insufficient_samples',return_method:null,return_base_at:null,source:'KIS_ACCOUNT_EQUITY'};
async function prepare(page:Page, points:EquityRecord[]=[one], second?:EquityRecord) {
  const latest=points.at(-1)!;
  await page.route('**/api/**', async route=>{
    const url=new URL(route.request().url());
    let result:unknown={ok:true};
    if(url.pathname==='/api/auth/me')result={user:{email:'qa@example.com'}};
    if(url.pathname==='/api/holdings')result={holdings:[],performance:[]};
    if(url.pathname==='/api/integration-token')result={active:false};
    if(url.pathname==='/api/manual-trades')result={trades:[],summary:[],next:null};
    if(url.pathname==='/api/briefing-status')result={collections:[],delivery:null,run:null,emailEnabled:false};
    if(url.pathname==='/api/account-equity')result=url.search ? {points:second && url.searchParams.get('account_ref')===second.account_ref ? [second] : points.filter(p=>p.date>=(url.searchParams.get('from')??'')),next:null} : {series:[latest,...(second?[second]:[])]};
    await route.fulfill({json:result});
  });
  await page.goto('/portfolio');
  await expect(page.getByRole('heading',{name:'연동 계좌 자산',exact:true})).toBeVisible();
  await expect(page.getByLabel('계좌 선택').locator('option')).toHaveCount(second?5:4);
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
  await expect(page.locator('.pf-equity-summary')).toHaveCount(0);
});
