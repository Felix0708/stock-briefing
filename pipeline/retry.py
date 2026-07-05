"""일시적 오류(429 쿼터, 503 혼잡 등)에 대한 재시도 유틸.

매일 무인으로 도는 파이프라인은 일시 장애를 스스로 견뎌야 한다.
지수 백오프: 실패할수록 대기 시간을 늘려 서버 부하를 주지 않으면서 재시도.
"""

import time


def with_retry(fn, *, attempts: int = 4, base_wait: float = 15.0, label: str = ""):
    """fn()을 실행하되, 일시적 오류면 대기 후 재시도.

    대기 시간: 15초 → 30초 → 60초 (지수 백오프)
    영구적 오류(인증 실패 등)는 즉시 전파한다.
    """
    for i in range(attempts):
        try:
            return fn()
        except Exception as e:
            msg = str(e)
            transient = any(
                marker in msg
                for marker in (
                    "429", "503", "500", "502", "504",
                    "UNAVAILABLE", "RESOURCE_EXHAUSTED",
                    "timed out", "timeout", "Max retries exceeded", "Connection",
                )
            )
            last_try = i == attempts - 1
            if not transient or last_try:
                raise
            wait = base_wait * (2**i)
            print(f"  ⏳ 일시 오류{f' ({label})' if label else ''}: {wait:.0f}초 후 재시도 ({i + 1}/{attempts - 1})")
            time.sleep(wait)
