import { test, expect, type Page } from "@playwright/test";

const holdings = [
  {stock_code:"SE",stock_name:"씨 ADR",market:"US",broker:"KIWOOM",source:"manual",account_type:"manual",quantity:10,avg_price:100},
  {stock_code:"STM",stock_name:"ST 마이크로 일렉트로닉스 ADR",market:"US",broker:"KIWOOM",source:"manual",account_type:"manual",quantity:2,avg_price:50},
  {stock_code:"ZETA",stock_name:"제타 글로벌 홀딩스",market:"US",broker:"KIS",source:"stock_trading",account_type:"paper",quantity:12,avg_price:30},
  {stock_code:"ZETA",stock_name:"제타 글로벌 홀딩스",market:"US",broker:"KIWOOM",source:"stock_trading",account_type:"paper",quantity:12,avg_price:30},
];
async function mock(page:Page, overrides:Record<string,unknown>={}, count=4){
  const calls:{url:string;method:string;body:unknown}[]=[];
  await page.route("**/api/**",async route=>{
    const req=route.request();const url=new URL(req.url());
    calls.push({url:url.pathname,method:req.method(),body:req.postDataJSON()});
    const data:Record<string,unknown>={
      "/api/auth/me":{user:{email:"demo@example.com",nickname:"검증 계정",briefingEmail:true}},
      "/api/holdings":{holdings,performance:[]},
      "/api/integration-token":{active:false},
      "/api/account-equity":{series:[]},
      "/api/quotes":{quotes:{"US:SE":{code:"SE",name:"씨 ADR",currency:"USD",price:110,changeRatio:1},"US:ZETA":{code:"ZETA",name:"제타 글로벌 홀딩스",currency:"USD",price:31,changeRatio:1}},usdKrw:1400,jpyKrw:null,asOf:new Date().toISOString()},
      "/api/manual-trades":req.method()!=="GET"?{ok:true,trade:{id:1,quantity_after:11,realized_profit_loss:null}}:{trades:[],summary:[],next:null},
      "/api/briefing-status":{collections:[],delivery:null,run:null,emailEnabled:true},
    };
    await route.fulfill({json:overrides[url.pathname]??data[url.pathname]??{ok:true}});
  });
  await page.goto("/portfolio");
  await expect(page.getByRole("heading",{name:"내 포트폴리오",exact:true}).last()).toBeVisible();
  await expect(page.locator(".pf-table tbody tr")).toHaveCount(count);
  return calls;
}

test("부분 합계·계좌 필터·원화 설정을 실제 렌더링과 조작으로 검증",async({page})=>{
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await mock(page);
  await expect(page.locator(".pf-summary")).toContainText("일부 평가");
  await expect(page.locator(".pf-summary")).toContainText("1,540,000원");
  await expect(page.getByText(/평가 2종목 중 1종목 반영/)).toBeVisible();
  await expect(page.getByText(/시세 없는 종목은 현재 환율로/)).toBeVisible();
  await page.getByLabel("계좌 선택",{exact:true}).selectOption("paper");
  await expect(page.locator(".pf-table tbody tr")).toHaveCount(2);
  await page.getByLabel("계좌 선택",{exact:true}).selectOption("KIWOOM:paper");
  await expect(page.locator(".pf-table tbody tr")).toHaveCount(1);
  await page.getByLabel("계좌 선택",{exact:true}).selectOption("broker:KIWOOM");
  await expect(page.locator(".pf-table tbody tr")).toHaveCount(3);
  await page.getByLabel("표 금액 원화로 보기",{exact:true}).check();
  await page.reload();
  await expect(page.getByLabel("표 금액 원화로 보기",{exact:true})).toBeChecked();
  expect(errors).toEqual([]);
});

test("과거 거래 정정·취소는 사유와 버전을 포함하고 확인 화면이 넘치지 않는다",async({page},info)=>{
  const trade={id:4,request_id:"00000000-0000-4000-8000-000000000004",market:"US",stock_code:"SE",stock_name:"씨 ADR",broker:"KIWOOM",side:"BUY",quantity:5,price:130,traded_on:"2026-09-01",quantity_after:15,realized_profit_loss:null,revision:2,cancelled:false};
  const calls=await mock(page,{"/api/manual-trades":{trades:[trade],summary:[],next:null}});
  await page.getByRole("button",{name:"정정 / 취소",exact:true}).click();
  await page.getByLabel("체결 단가 (USD)",{exact:true}).fill("160");
  await page.getByLabel("정정 사유",{exact:true}).fill("체결 단가 오입력 수정");
  await page.getByLabel("이 거래 취소 (삭제하지 않고 이력 보존)",{exact:true}).check();
  await page.locator(".pf-trade-form").screenshot({path:info.outputPath("trade-correction.png")});
  await page.getByRole("button",{name:"정정 저장",exact:true}).click();
  expect(calls.find(call=>call.method==="PATCH")!.body).toMatchObject({trade_id:4,expected_revision:2,cancelled:true,reason:"체결 단가 오입력 수정",trade:{price:160}});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test("백업 복원은 미리보기와 명시적 교체 확인 없이는 진행되지 않는다",async({page},info)=>{
  await mock(page);
  const writes:Record<string,unknown>[]=[];
  await page.route("**/api/portfolio-backup",async route=>{
    const body=route.request().postDataJSON();
    if(body)writes.push(body);
    await route.fulfill({json:body?{holdings:4,trades:2,revisions:1,fingerprint:"a".repeat(32)}:{fingerprint:"a".repeat(32)}});
  });
  await page.getByText("백업 파일 복원",{exact:true}).click();
  await page.getByLabel("백업 JSON 파일",{exact:true}).setInputFiles({name:"backup.json",mimeType:"application/json",buffer:Buffer.from('{"format":"stock-briefing.portfolio"}')});
  await page.getByRole("button",{name:"복원 미리보기",exact:true}).click();
  await expect(page.getByRole("button",{name:"확인한 백업으로 복원",exact:true})).toBeDisabled();
  expect(writes[0].apply).toBe(false);
  await page.getByLabel("현재 데이터를 이 백업으로 교체하는 것을 확인했습니다.",{exact:true}).check();
  await expect(page.getByRole("button",{name:"확인한 백업으로 복원",exact:true})).toBeEnabled();
  await page.locator('section[aria-labelledby="backup-title"]').screenshot({path:info.outputPath("backup-preview.png")});
  expect(writes.filter(row=>row.apply)).toHaveLength(0);
});

test("긴 배지·범례가 화면 밖으로 넘치지 않고 중앙에 정렬된다",async({page},info)=>{
  await mock(page);
  const size=await page.evaluate(()=>({content:document.documentElement.scrollWidth,width:innerWidth}));
  expect(size.content).toBeLessThanOrEqual(size.width);
  for(const badge of await page.locator(".pf-source-badge").all()){
    const rect=await badge.boundingBox();expect(rect!.x+rect!.width).toBeLessThanOrEqual(size.width);
  }
  const legend=page.locator(".pf-legend li").first();
  await legend.scrollIntoViewIfNeeded();
  const dot=await legend.locator(".pf-dot").boundingBox();
  const label=await legend.locator(".pf-legend-label").boundingBox();
  expect(Math.abs(dot!.y+dot!.height/2-label!.y-label!.height/2)).toBeLessThan(2);
  await page.screenshot({path:info.outputPath("portfolio.png"),fullPage:true});
  await page.emulateMedia({colorScheme:"dark"});
  await page.locator(".pf-pie-card").first().screenshot({path:info.outputPath("chart-dark.png")});
  await page.locator(".pf-table tbody tr").last().screenshot({path:info.outputPath("holding-dark.png")});
});

test("환율 누락 시 가짜 100% 비중이나 원화 평가액을 만들지 않는다",async({page})=>{
  await mock(page,{"/api/quotes":{quotes:{},usdKrw:null,jpyKrw:null,asOf:new Date().toISOString()}});
  await expect(page.getByText("환율 정보가 없어 비중을 계산할 수 없습니다.",{exact:true})).toHaveCount(3);
  await expect(page.locator(".pf-pie")).toHaveCount(0);
  await expect(page.locator(".pf-table tbody tr").first()).toContainText("환율 대기");
  await expect(page.locator(".pf-summary")).not.toContainText("0원");
});

test("삭제 취소는 서버에 DELETE 요청을 보내지 않는다",async({page})=>{
  const calls=await mock(page);
  await page.clock.install();
  await page.getByRole("button",{name:"씨 ADR (SE) 삭제",exact:true}).click();
  await page.getByRole("button",{name:"삭제 취소",exact:true}).click();
  await page.clock.fastForward(9000);
  await expect(page.getByText(/8초 뒤 잔고에서 삭제/)).toHaveCount(0);
  expect(calls.filter(call=>call.method==="DELETE")).toHaveLength(0);
  await expect(page.locator(".pf-table tbody tr")).toHaveCount(4);
});

test("수동 매수 입력이 통화·증권사와 함께 API에 전달된다",async({page})=>{
  const calls=await mock(page);
  await page.getByText("매수·매도 기록하기",{exact:true}).click();
  await page.getByLabel("기존 보유 종목",{exact:true}).selectOption("KIWOOM:US:SE");
  await page.getByLabel("체결 수량",{exact:true}).fill("1");
  await page.getByLabel("체결 단가 (USD)",{exact:true}).fill("105");
  await page.getByRole("button",{name:"거래 기록",exact:true}).click();
  await expect(page.getByText(/매수 기록 완료 · 거래 직후 수량 11/)).toBeVisible();
  expect(calls.find(call=>call.url==="/api/manual-trades"&&call.method==="POST")!.body).toMatchObject({market:"US",broker:"KIWOOM",side:"BUY",quantity:1,price:105});
});
