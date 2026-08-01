# Sandbox de execucao Python - imagem minima e usuario sem privilegio.
FROM python:3.11-slim

# Nao gerar .pyc e nao bufferizar logs (facilita ver erros no Render).
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Instala dependencias primeiro (cache de build).
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copia o codigo do servico.
COPY app.py .

# Cria um usuario sem privilegio e roda como ele (nunca root).
RUN useradd --create-home --uid 10001 sandbox
USER sandbox

# O Render injeta a porta em $PORT. Gunicorn com 2 workers e timeout curto.
# 'sh -c' e necessario para expandir a variavel $PORT.
CMD ["sh", "-c", "gunicorn --bind 0.0.0.0:${PORT:-8000} --workers 2 --timeout 30 app:app"]
