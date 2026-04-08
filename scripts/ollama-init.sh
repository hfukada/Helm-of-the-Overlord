#!/bin/sh
# Start Ollama server in background, pull required models, then wait.

/bin/ollama serve &
OLLAMA_PID=$!

echo "[hoto-init] Waiting for Ollama to start..."
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:11434/api/tags > /dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "[hoto-init] Pulling required models..."
ollama pull llama3.2:3b
ollama pull nomic-embed-text
echo "[hoto-init] Models ready."

wait $OLLAMA_PID
