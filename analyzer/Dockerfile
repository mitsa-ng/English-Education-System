FROM python:3.13-slim

WORKDIR /app

# PyMuPDF/rapidocr 需要的系統庫極少（pure wheel）；先裝 requirements 以利層快取
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

ENV ANALYZER_USE_GPU=false

EXPOSE 8000
# 單 worker：Ollama 推論本身序列化，多 worker 只增加記憶體（契約 §3）
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
