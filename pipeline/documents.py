"""Text extraction for regulator documents; no execution of embedded HTML or ZIP paths."""
import io
import re
import zipfile
from html import unescape, escape
from html.parser import HTMLParser

MAX_DOCUMENT_BYTES = 40 * 1024 * 1024


def text_from_html(raw: str) -> str:
    raw = re.sub(r"<(script|style|ix:header)\b[^>]*>.*?</\1>", " ", raw, flags=re.S | re.I)
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", raw))).strip()


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self.links.extend(value for key, value in attrs if key == "href" and value)


class SummaryHTML(HTMLParser):
    """The model may format text, but may not add active content, links or attributes."""
    allowed={'ul','li','b','strong','p','br','em'}

    def __init__(self):
        super().__init__()
        self.parts=[]

    def handle_starttag(self,tag,attrs):
        if tag in self.allowed: self.parts.append(f'<{tag}>')

    def handle_endtag(self,tag):
        if tag in self.allowed and tag!='br': self.parts.append(f'</{tag}>')

    def handle_data(self,data):
        self.parts.append(escape(data))


def extract_text(content: bytes) -> str:
    if len(content) > MAX_DOCUMENT_BYTES:
        raise ValueError("Document too large")
    if content.startswith(b"%PDF"):
        from pypdf import PdfReader
        parts = []
        for page in PdfReader(io.BytesIO(content)).pages:
            stream = page.get_contents()
            if stream is not None and len(stream.get_data()) > MAX_DOCUMENT_BYTES:
                raise ValueError("PDF page too large")
            parts.append(page.extract_text() or "")
        return "\n".join(parts).strip()
    if content.startswith(b"PK"):
        parts = []
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            entries = [item for item in archive.infolist() if not item.is_dir()
                       and item.filename.lower().endswith((".htm", ".html", ".xbrl", ".xml"))
                       and not item.filename.lower().endswith(("_cal.xml", "_def.xml", "_lab.xml", "_pre.xml"))]
            # Inline XBRL contains the report's readable narrative; avoid duplicate taxonomy data.
            reports = [item for item in entries if "/publicdoc/" in item.filename.lower()]
            entries = reports or entries
            html_entries = [item for item in entries if item.filename.lower().endswith((".htm", ".html"))]
            entries = html_entries or entries
            if sum(item.file_size for item in entries) > MAX_DOCUMENT_BYTES:
                raise ValueError("Expanded document too large")
            for item in sorted(entries, key=lambda item: item.filename):
                parts.append(text_from_html(archive.read(item).decode("utf-8-sig", errors="replace")))
        return "\n".join(parts).strip()
    return text_from_html(content.decode("utf-8-sig", errors="replace"))
