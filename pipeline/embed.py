"""공시 원문 임베딩 → Supabase(pgvector) 저장.

흐름: 원문 텍스트 → 청크 분할 → Gemini 임베딩 API(무료 티어) → Supabase REST 업서트

설계 포인트:
- Supabase 접속은 PostgREST(REST API)로 한다 → DB 드라이버(psycopg) 불필요, 의존성 최소화
- unique(rcept_no, chunk_idx) 제약 + merge-duplicates로 재실행해도 중복 저장 없음 (멱등성)
- 임베딩 실패는 경고만 남기고 파이프라인을 죽이지 않는다 (브리핑이 본업, RAG는 부가)
"""

import requests
from google import genai

from .retry import with_retry


def chunk_text(text: str, size: int = 1000, overlap: int = 150) -> list[str]:
    """긴 원문을 겹침(overlap) 있는 청크로 분할.

    겹침을 두는 이유: 문장이 청크 경계에서 잘려도
    인접 청크에 온전한 형태가 남아 검색에 걸리도록 하기 위함.
    """
    if not text:
        return []
    chunks = []
    start = 0
    step = size - overlap
    while start < len(text):
        chunks.append(text[start : start + size])
        start += step
    return chunks


def embed_texts(api_key: str, model: str, texts: list[str], dim: int) -> list[list[float]]:
    """텍스트 목록을 임베딩 벡터로 변환 (한 번의 API 호출로 배치 처리)."""
    client = genai.Client(api_key=api_key)
    resp = with_retry(
        lambda: client.models.embed_content(
            model=model,
            contents=texts,
            config={"output_dimensionality": dim},
        ),
        label="임베딩",
    )
    return [e.values for e in resp.embeddings]


def upsert_chunks(
    supabase_url: str,
    secret_key: str,
    filing: dict,
    chunks: list[str],
    embeddings: list[list[float]],
) -> None:
    """청크+벡터를 Supabase filings 테이블에 업서트."""
    rows = [
        {
            "rcept_no": filing["rcept_no"],
            "company": filing.get("company", filing.get("flr_nm", "")),
            "report_nm": filing["report_nm"],
            "rcept_dt": filing["rcept_dt"],
            "url": filing["url"],
            "chunk_idx": i,
            "content": chunk,
            "embedding": emb,
        }
        for i, (chunk, emb) in enumerate(zip(chunks, embeddings))
    ]
    resp = requests.post(
        f"{supabase_url}/rest/v1/filings",
        params={"on_conflict": "rcept_no,chunk_idx"},
        headers={
            "apikey": secret_key,
            "Authorization": f"Bearer {secret_key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates",
        },
        json=rows,
        timeout=60,
    )
    resp.raise_for_status()


def already_indexed(supabase_url: str, secret_key: str, rcept_no: str) -> bool:
    """이 공시가 이미 인덱싱돼 있는지 확인 (임베딩 API 호출 절약)."""
    resp = requests.get(
        f"{supabase_url}/rest/v1/filings",
        params={"rcept_no": f"eq.{rcept_no}", "select": "rcept_no", "limit": 1},
        headers={"apikey": secret_key, "Authorization": f"Bearer {secret_key}"},
        timeout=15,
    )
    resp.raise_for_status()
    return bool(resp.json())


def index_filing(settings, company: str, filing: dict, doc_text: str) -> int:
    """공시 1건을 청크→임베딩→저장까지 처리. 저장한 청크 수를 반환.

    이미 인덱싱된 공시는 건너뛴다(0 반환) — 임베딩 쿼터 절약.
    rcept_no는 DART 고유 접수번호라 같은 공시를 다시 만날 일이 없고,
    정정공시는 새 접수번호를 받으므로 놓치지 않는다.
    """
    if already_indexed(settings.supabase_url, settings.supabase_secret_key, filing["rcept_no"]):
        return 0
    chunks = chunk_text(doc_text)
    if not chunks:
        return 0
    embeddings = embed_texts(
        settings.gemini_api_key, settings.embedding_model, chunks, settings.embedding_dim
    )
    filing_with_company = {**filing, "company": company}
    upsert_chunks(
        settings.supabase_url, settings.supabase_secret_key, filing_with_company, chunks, embeddings
    )
    return len(chunks)
