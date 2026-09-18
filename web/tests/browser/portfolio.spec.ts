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
      "/api/tax-estimate":{year:2026,rows:[]},
      "/api/quotes":{quotes:{"US:SE":{code:"SE",name:"씨 ADR",currency:"USD",price:110,changeRatio:1},"US:ZETA":{code:"ZETA",name:"제타 글로벌 홀딩스",currency:"USD",price:31,changeRatio:1}},usdKrw:1400,jpyKrw:null,asOf:new Date().toISOString()},
      "/api/manual-trades":req.method()!=="GET"?{ok:true,trade:{id:1,quantity_after:11,realized_profit_loss:null}}:{trades:[],summary:[],next:null},
      "/api/briefing-status":{collections:[],delivery:null,run:null,emailEnabled:true},
    };
    await route.fulfill({json:overrides[url.pathname]??data[url.pathname]??{ok:true}});
  });
  await page.goto("/portfolio");
  await expect(page.getByRole("heading",{name:"내 포트폴리오",exact:true}).last()).toBeVisible();
  await expect(page.locator(".pf-table .pf-holding-row")).toHaveCount(count);
  return calls;
}

test("계좌 안내와 총자산·세금 입력 블록의 간격은 동일하다",async({page},info)=>{
  await mock(page,{"/api/holdings":{holdings:[...holdings,{...holdings[0],broker:"KIS"}],performance:[]}},5);
  await page.getByLabel("계좌 선택",{exact:true}).selectOption("live");
  const results=page.locator(".pf-equity-results");
  await expect(results.locator(":scope > .pf-notice")).toHaveCount(2);
  const boxes=await results.locator(":scope > *").evaluateAll(els=>els.map(el=>({top:el.getBoundingClientRect().top,bottom:el.getBoundingClientRect().bottom})));
  for(let i=1;i<boxes.length;i++) expect(boxes[i].top-boxes[i-1].bottom).toBeCloseTo(14,0);
  const tax=page.getByRole("region",{name:"미국·일본 주식 예상 세금 · 2026년"});
  await expect(tax).toContainText("실계좌 매매 기록 자동 계산");
  await expect(tax.getByLabel("연간 예상 세금 결과")).toBeVisible();
  await expect(tax.getByLabel("미국 연간 실현손익 (원)")).toHaveCount(0);
  expect(await results.locator(".pf-summary").evaluate(el=>getComputedStyle(el).gap)).toBe("14px");
  expect(await tax.locator(".pf-summary").evaluate(el=>getComputedStyle(el).gap)).toBe("14px");
  const taxBoxes=await tax.locator(":scope > *").evaluateAll(els=>els.map(el=>({top:el.getBoundingClientRect().top,bottom:el.getBoundingClientRect().bottom})));
  for(let i=1;i<taxBoxes.length;i++) expect(taxBoxes[i].top-taxBoxes[i-1].bottom).toBeCloseTo(14,0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await results.screenshot({path:info.outputPath("equity-spacing.png")});
  await tax.screenshot({path:info.outputPath("tax-spacing.png")});
});

test("원화 합계와 USD·JPY 원금액, 연간 세금과 가정 매도는 모의·계좌 필터와 분리된다",async({page},info)=>{
  const calls=await mock(page,{
    "/api/holdings":{holdings:[...holdings,{stock_code:"7203",stock_name:"토요타",market:"JP",broker:"KIS",source:"manual",account_type:"manual",quantity:1,avg_price:10000}],performance:[]},
    "/api/quotes":{quotes:{"US:SE":{price:110,changeRatio:0},"US:STM":{price:55,changeRatio:0},"US:ZETA":{price:31,changeRatio:0},"JP:7203":{price:11000,changeRatio:0}},usdKrw:1400,jpyKrw:10,asOf:new Date().toISOString()},
  },5);
  const summary=page.getByLabel("실계좌 등록 주식 합계");
  await expect(summary).toContainText("USD $1,210");await expect(summary).toContainText("JPY ¥11,000");
  await expect(summary).toContainText("1,804,000원");
  await summary.screenshot({path:info.outputPath("native-totals.png")});
  await page.getByLabel("표 금액 원화로 보기",{exact:true}).check();
  await expect(summary).toContainText("USD $1,210");
  const tax=page.getByRole("region",{name:"미국·일본 주식 예상 세금 · 2026년"});
  await tax.getByText("증권사 자료로 직접 보정하기 (선택)",{exact:true}).click();
  await tax.getByLabel("자동 추정 대신 직접 입력 사용").check();
  await expect(tax.getByLabel("연간 예상 세금 결과")).toHaveCount(0);
  await tax.getByLabel("미국 연간 실현손익 (원)").fill("10000000");
  await tax.getByLabel("일본 연간 실현손익 (원)").fill("-2000000");
  await tax.getByLabel("미국·일본 모든 실계좌 손익을 포함했고 아래 일반 과세 조건에 해당합니다.").check();
  await expect(tax.getByLabel("연간 예상 세금 결과")).toContainText("1,210,000원");
  await expect(tax.getByLabel("연간 예상 세금 결과")).toContainText("6,790,000원");
  await tax.getByText("등록된 해외주식을 지금 전량 매도한다면?",{exact:true}).click();
  await expect(tax).toContainText("가정 매도대금: 1,804,000원");
  await tax.getByLabel("대상 주식 세금용 취득가액·매수비용 합계 (원)").fill("1000000");
  await tax.getByLabel("예상 매도비용 합계 (원)").fill("4000");
  await tax.getByLabel("취득가액은 위 대상 수량 전체와 일치하며 중복 등록이 없습니다.").check();
  await expect(tax.getByLabel("가정 매도 세후 결과")).toContainText("624,000원");
  await tax.screenshot({path:info.outputPath("foreign-tax.png")});
  await page.getByLabel("계좌 선택",{exact:true}).selectOption("paper");
  await expect(tax.getByLabel("가정 매도 세후 결과")).toContainText("624,000원");
  await tax.getByLabel("일본 연간 실현손익 (원)").fill("");
  await expect(tax.getByLabel("연간 예상 세금 결과")).toHaveCount(0);
  expect(calls.filter(call=>call.method!=="GET")).toEqual([]);
  expect(await tax.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
});

test("실계좌 기록만 자동 계산하고 계좌 필터·가정 매도와 조회 실패를 구분한다",async({page},info)=>{
  const row={source:"manual",broker:"KIWOOM",market:"US",sell_count:2,missing_count:0,profit_loss:5000,updated_at:"2026-09-18T00:00:00Z"};
  const calls=await mock(page,{"/api/tax-estimate":{year:2026,rows:[row,{...row,source:"stock_trading",broker:"KIS",profit_loss:-1000}]}});
  const tax=page.getByRole("region",{name:"미국·일본 주식 예상 세금 · 2026년"});
  await expect(tax.getByLabel("연간 예상 세금 결과")).toContainText("682,000원");
  await expect(tax.getByLabel("연간 예상 세금 결과")).toContainText("4,918,000원");
  await expect(tax.getByLabel("미국 연간 실현손익 (원)")).toHaveCount(0);
  await page.getByLabel("계좌 선택",{exact:true}).selectOption("paper");
  await expect(tax.getByLabel("연간 예상 세금 결과")).toContainText("682,000원");
  await tax.screenshot({path:info.outputPath("automatic-tax.png")});
  await page.route("**/api/tax-estimate",r=>r.fulfill({status:502,json:{error:"unavailable"}}));
  await page.getByRole("button",{name:"시세 새로고침",exact:true}).click();
  await expect(tax.getByRole("alert")).toContainText("0원으로 계산하지 않습니다");
  await expect(tax.getByLabel("연간 예상 세금 결과")).toHaveCount(0);
  await page.route("**/api/tax-estimate",r=>r.fulfill({json:{year:2026,rows:[{...row,missing_count:1}]}}));
  await tax.getByRole("button",{name:"매도 기록 다시 조회"}).click();
  await expect(tax).toContainText("미확인 1건으로 계산 보류");
  await expect(tax.getByLabel("연간 예상 세금 결과")).toHaveCount(0);
  expect(calls.filter(c=>c.method!=="GET")).toEqual([]);
});

test("외화 환율 누락도 원금액은 보존하고 가정 세후 손익은 만들지 않는다",async({page})=>{
  await mock(page,{"/api/quotes":{quotes:{"US:SE":{price:110,changeRatio:0}},usdKrw:null,jpyKrw:null,asOf:new Date().toISOString()}});
  await expect(page.getByLabel("실계좌 등록 주식 합계")).toContainText("USD $1,100 (일부)");
  const tax=page.getByRole("region",{name:"미국·일본 주식 예상 세금 · 2026년"});
  await tax.getByText("등록된 해외주식을 지금 전량 매도한다면?",{exact:true}).click();
  await expect(tax).toContainText("시세·환율 또는 보유종목 미확인 · 계산 보류");
  await expect(tax.getByLabel("가정 매도 세후 결과")).toHaveCount(0);
});

test("부분 합계·계좌 필터·원화 설정을 실제 렌더링과 조작으로 검증",async({page})=>{
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await mock(page);
  await expect(page.getByLabel("실계좌 등록 주식 합계")).toContainText("일부 평가");
  await expect(page.getByLabel("실계좌 등록 주식 합계")).toContainText("1,540,000원");
  await expect(page.getByLabel("모의계좌 등록 주식 합계")).toContainText("1,041,600원");
  await expect(page.getByText(/직접 등록 보유종목만 있습니다/)).toBeVisible();
  await expect(page.getByText(/평가 2종목 중 1종목 반영/)).toBeVisible();
  await expect(page.getByText(/시세 없는 종목은 현재 환율로/)).toBeVisible();
  await page.getByLabel("계좌 선택",{exact:true}).selectOption("paper");
  await expect(page.getByLabel("실계좌 등록 주식 합계")).toHaveCount(0);
  await expect(page.locator(".pf-table .pf-holding-row")).toHaveCount(2);
  await page.getByLabel("계좌 선택",{exact:true}).selectOption("live");
  await expect(page.locator(".pf-table .pf-holding-row")).toHaveCount(2);
  await page.getByLabel("계좌 선택",{exact:true}).selectOption("broker:KIWOOM");
  await expect(page.locator(".pf-table .pf-holding-row")).toHaveCount(3);
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
  await page.getByRole("region",{name:"직접 투자 · 매매 이력"}).locator(".pf-trade-form").screenshot({path:info.outputPath("trade-correction.png")});
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
  await page.locator(".pf-table .pf-holding-row").last().screenshot({path:info.outputPath("holding-dark.png")});
});

test("환율 누락 시 가짜 100% 비중이나 원화 평가액을 만들지 않는다",async({page})=>{
  await mock(page,{"/api/quotes":{quotes:{},usdKrw:null,jpyKrw:null,asOf:new Date().toISOString()}});
  await expect(page.getByText("환율 정보가 없어 비중을 계산할 수 없습니다.",{exact:true})).toHaveCount(3);
  await expect(page.locator(".pf-pie")).toHaveCount(0);
  await expect(page.locator(".pf-table .pf-holding-row").first()).toContainText("환율 대기");
  await expect(page.getByLabel("실계좌 등록 주식 합계")).not.toContainText("0원");
});

test("삭제 취소는 서버에 DELETE 요청을 보내지 않는다",async({page})=>{
  const calls=await mock(page);
  await page.clock.install();
  await page.getByRole("button",{name:"씨 ADR (SE) 삭제",exact:true}).click();
  await page.getByRole("button",{name:"삭제 취소",exact:true}).click();
  await page.clock.fastForward(9000);
  await expect(page.getByText(/8초 뒤 잔고에서 삭제/)).toHaveCount(0);
  expect(calls.filter(call=>call.method==="DELETE")).toHaveLength(0);
  await expect(page.locator(".pf-table .pf-holding-row")).toHaveCount(4);
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

test("증권사별 실계좌·모의 묶음과 직접·자동 배지, 비중·그래프 색상이 일치한다",async({page},info)=>{
  const mixed=[...holdings,
    {...holdings[0],source:"stock_trading",account_type:"live"},
    {stock_code:"017670",stock_name:"SK텔레콤",market:"KR",broker:"KIS",source:"manual",account_type:"manual",quantity:1,avg_price:50000},
  ];
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  const calls=await mock(page,{"/api/holdings":{holdings:mixed,performance:[]}},6);
  const groups=page.locator(".pf-account-group");
  await expect(groups).toHaveCount(4);
  expect(await groups.evaluateAll(elements=>elements.map(e=>e.getAttribute("aria-label")))).toEqual([
    "키움증권 실계좌","한국투자증권 실계좌","키움증권 모의계좌","한국투자증권 모의계좌",
  ]);
  await expect(groups.first().locator(".pf-account-count")).toHaveText("3종목 · 직접 2 · 자동 1");
  await expect(groups.first().locator(".pf-source-badge")).toHaveText(["직접","직접","자동"]);
  await expect(groups.first().locator('[data-label="계좌 내 비중"]')).toHaveText(["47.8%","4.3%","47.8%"]);
  await expect(groups.first().locator(".pf-delete")).toHaveCount(2);
  for(let i=0;i<4;i++){
    const colors=await groups.nth(i).locator(".pf-dot").evaluateAll(nodes=>nodes.map(n=>getComputedStyle(n).backgroundColor));
    const legendColors=await page.locator(".pf-pie-card").nth(i).locator(".pf-dot").evaluateAll(nodes=>nodes.map(n=>getComputedStyle(n).backgroundColor));
    expect(colors).toEqual(legendColors);
  }
  await page.emulateMedia({colorScheme:"light"});
  await page.locator(".pf-table").screenshot({path:info.outputPath("account-groups-light.png")});
  await page.emulateMedia({colorScheme:"dark"});
  await page.locator(".pf-table").screenshot({path:info.outputPath("account-groups-dark.png")});
  const liveColor=await groups.first().locator(".pf-account-heading").evaluate(e=>getComputedStyle(e).backgroundColor);
  const paperColor=await groups.nth(2).locator(".pf-account-heading").evaluate(e=>getComputedStyle(e).backgroundColor);
  expect(liveColor).not.toBe(paperColor);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  if(info.project.name==="desktop"){
    const heights=await page.locator(".pf-holding-row").evaluateAll(rows=>rows.map(row=>row.getBoundingClientRect().height));
    expect(Math.max(...heights)-Math.min(...heights)).toBeLessThan(1);
  }
  await page.getByLabel("계좌 선택",{exact:true}).selectOption("paper");
  await expect(groups).toHaveCount(2);
  await expect(page.locator(".pf-account-live")).toHaveCount(0);
  expect(calls.filter(call=>call.method!=="GET")).toHaveLength(0);
  expect(errors).toEqual([]);
});
