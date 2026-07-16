# Fábrica falsa

Cliente Node.js exclusivo para desenvolvimento local. Ele usa MQTT TCP em
`mqtt://127.0.0.1:1883`, assina `f/i/order`, valida o contrato da ordem e publica
respostas em `eldorado/demo/factory/order/status`.

## Iniciar

1. Inicie primeiro o broker Mosquitto.
2. Execute `start-fake-factory.bat`.

Na primeira execução, o script instala o pacote `mqtt`. Depois, o terminal mostra
o payload bruto, o resultado da validação e cada resposta publicada.

## Contrato validado

- JSON com exatamente `type` e `ts`;
- `type` igual a `WHITE`, `RED` ou `BLUE`;
- `ts` no formato `YYYY-MM-DDTHH:mm:ss.SSZ`;
- nenhuma publicação retained.

Uma ordem válida recebe `RECEIVED` imediatamente, `ACCEPTED` após cerca de 700 ms
e `COMPLETED` após cerca de 8,5 s. Uma ordem inválida recebe `REJECTED` com
`reason: "INVALID_PAYLOAD"`.

Pressione `Ctrl+C` para encerrar de forma limpa.
