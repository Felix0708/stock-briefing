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
      "/api/quotes":{quotes:{"US:SE":{code:"SE",name:"씨 ADR",currency:"USD",price:110,changeRatio:1},"US:ZETA":{code:"ZETA",name:"제타 글로벌 홀딩스",currency:"USD",price:31,changeRatio:1}},usdKrw:1400,jpyKrw:null,asOf:new Date().toISOString()},
      "/api/manual-trades":req.method()==="POST"?{ok:true,trade:{id:1,quantity_after:11,realized_profit_loss:null}}:{trades:[],summary:[],next:null},
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
  await page.getByLabel("계좌 유형",{exact:true}).selectOption("paper");
  await expect(page.locator(".pf-table tbody tr")).toHaveCount(2);
  await page.getByLabel("증권사 필터",{exact:true}).selectOption("KIWOOM");
  await expect(page.locator(".pf-table tbody tr")).toHaveCount(1);
  await page.getByLabel("표 금액 원화로 보기",{exact:true}).check();
  await page.reload();
  await expect(page.getByLabel("표 금액 원화로 보기",{exact:true})).toBeChecked();
  expect(errors).toEqual([]);
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
  await expect(page.getByText(/매수 기록 완료 · 남은 수량 11/)).toBeVisible();
  expect(calls.find(call=>call.url==="/api/manual-trades"&&call.method==="POST")!.body).toMatchObject({market:"US",broker:"KIWOOM",side:"BUY",quantity:1,price:105});
});
