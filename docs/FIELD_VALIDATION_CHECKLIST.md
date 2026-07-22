# Checklist de validação em campo

Registre data, operador, equipamento e evidência de cada teste. Não marque um item
apenas porque ele aparece no código ou na documentação de referência.

## Cenário físico observado em 2026-07-22

- [ ] Notebook conectado por Wi-Fi à rede `Smart Factory 4.0`.
- [ ] Notebook recebeu `192.168.0.11` no Wi-Fi.
- [ ] Ethernet permanece conectada à rede do Instituto para Internet/rede corporativa.
- [ ] Rota `192.168.0.0/24` ocorre pelo Wi-Fi e não substitui a rota da Ethernet.
- [ ] Broker responde em `192.168.0.10:1883`.
- [ ] Node-RED responde em `192.168.0.5:1880`.
- [ ] `192.168.0.1` está registrado como roteador TP-Link, não como PLC.
- [ ] Pendência OPC UA registrada: o connector Node-RED aponta para
      `opc.tcp://192.168.0.1:4840`, mas a porta não respondeu a partir do notebook.
- [ ] Nenhum IP alternativo de PLC foi presumido.

## Teste atual: somente leitura

- [ ] `start-all-simulation.bat` **não** foi executado.
- [ ] Mosquitto local **não** foi iniciado.
- [ ] Fake factory **não** foi iniciado.
- [ ] `gateway/.env` foi criado a partir de `gateway/.env.factory.example`.
- [ ] A configuração abaixo foi conferida antes de iniciar:

```dotenv
APP_HOST=127.0.0.1
APP_PORT=8080
MODE=factory
MQTT_URL=mqtt://192.168.0.10:1883
MQTT_USERNAME=
MQTT_PASSWORD=
FACTORY_COMMANDS_ENABLED=false
FACTORY_INFER_WAITING_ON_BOOT=true
FACTORY_BOOTSTRAP_GRACE_MS=6000
MQTT_ORDER_TOPIC=f/o/order
MQTT_ORDER_STATE_TOPIC=f/i/order
MQTT_STOCK_TOPIC=f/i/stock
MQTT_STATION_STATE_TOPIC=f/i/state/+
MQTT_ENABLE_CAMERA_TOPIC=false
MQTT_ENABLE_RAW_DIAGNOSTICS=true
TOPIC_HISTORY_LIMIT=100
```

- [ ] `start-gateway.bat` foi o único processo do workspace iniciado.
- [ ] Web App abriu em `http://localhost:8080`.
- [ ] `GET /health` mostra processo online, MQTT conectado e
      `commandsEnabled=false`.
- [ ] `GET /api/state` recebe o snapshot da fábrica.
- [ ] `GET /api/stock` recebe estoque lógico de `f/i/stock`.
- [ ] `GET /api/topics` mostra o último valor de cada tópico.
- [ ] `GET /api/events` preserva a sequência recente.
- [ ] WebSocket permanece operacional e a UI mostra estados/estoque.
- [ ] Se `f/i/order` estiver silencioso no cold start, o gateway aguarda 6 segundos
      e só infere WAITING quando estoque e as seis estações READY estão recentes.
- [ ] O estado inferido aparece com `inferred=true` e
      `freshnessPolicy=station-bootstrap` em `/api/state`.
- [ ] Uma estação com `code!=1`, estoque inválido/stale ou evento real de pedido
      impede a inferência.
- [ ] Uma tentativa controlada de `POST /api/orders` retorna HTTP 403 com
      `FACTORY_COMMANDS_DISABLED`.
- [ ] Nenhuma publicação apareceu em `f/o/order` durante o teste read-only.

## Validação passiva dos payloads

- [ ] `f/i/state/dsi`, `dso`, `hbw`, `mpo`, `vgr` e `sld` chegam aproximadamente
      a cada 2 segundos.
- [ ] `f/i/stock` chega aproximadamente a cada 2 segundos.
- [ ] Estado READY aceita `code=1`, `description=""`, `active=false` e `target=""`.
- [ ] `active` boolean não é usado para inferir READY/BUSY; `code` é a autoridade.
- [ ] Posição vazia com `workpiece=null` é aceita.
- [ ] Posição vazia com `id="0"`, `type=""`, `state=""` é aceita.
- [ ] Snapshot observado foi conferido como fixture, não como valor fixo do produto:
      WHITE=2, RED=3, BLUE=1, EMPTY=3.
- [ ] A UI/API identifica a contagem como estoque **lógico**, proveniente de
      `f/i/stock`, e não como inspeção física.
- [ ] Divergência atual entre estoque lógico e posicionamento físico foi registrada.
- [ ] `i/cam` permanece fora do histórico circular por padrão.

## Observação do ciclo real

- [ ] `/api/events` permite reconstruir todas as mensagens, inclusive repetições.
- [ ] `ORDERED` inicial foi registrado.
- [ ] `IN_PROCESS` repetido foi preservado no histórico sem duplicar transições da UI.
- [ ] Retorno a `WAITING_FOR_ORDER` concluiu/liberou o ciclo mesmo sem `SHIPPED`.
- [ ] Ciclo sem `SHIPPED` registrou `completedWithoutShipped=true`, sem erro operacional.
- [ ] `WAITING_FOR_ORDER` repetido foi idempotente.
- [ ] Se `SHIPPED` aparecer em execução futura, ele continua reconhecido normalmente.
- [ ] Não foi concluído que `SHIPPED` inexiste; apenas não foi observado no
      primeiro pedido RED real.

## Futuro teste com comandos

Somente executar depois de autorização operacional, reconciliação manual entre
estoque físico/lógico e esclarecimento da comunicação PLC.

- [ ] Autorização nominal/data registrada.
- [ ] Estoque físico foi reconciliado manualmente com `f/i/stock`.
- [ ] `WAITING_FOR_ORDER` e estações foram conferidos novamente.
- [ ] `FACTORY_COMMANDS_ENABLED=true` foi definido explicitamente.
- [ ] Gateway foi reiniciado e `/health` confirma `commandsEnabled=true`.
- [ ] Uma única ordem foi enviada pelo Web App.
- [ ] `f/o/order` contém exatamente `type` e `ts`, QoS 0, `retain=false`.
- [ ] Nenhum retry automático ocorreu em timeout ou queda.
- [ ] `/api/events` e `/api/topics` foram observados durante todo o ciclo.
- [ ] A cor produzida e a alteração de estoque foram verificadas fisicamente.
- [ ] Ao terminar, comandos foram desabilitados novamente se a janela de teste acabou.

## Falhas controladas

- [ ] Queda MQTT antes do POST bloqueia o pedido.
- [ ] Queda depois do publish deixa estado incerto e não reenvia.
- [ ] JSON/schema inválido aparece no diagnóstico sem derrubar o gateway.
- [ ] Estado desconhecido não é tratado como válido.
- [ ] Estoque stale, inconsistente ou zerado bloqueia o pedido.
- [ ] Mensagem retained antiga não é usada como estado de controle.
- [ ] Histórico circular respeita `TOPIC_HISTORY_LIMIT`.

## Registro de divergências

```text
Data/hora:
Operador:
Equipamento/origem:
Tópico/endpoint:
Esperado:
Observado:
Payload bruto:
QoS/retain/bytes:
Impacto:
Decisão/pendência:
```

## Fora do escopo

- [ ] Nenhum Caddy, TLS, Cloudflare, certificado ou túnel foi alterado.
- [ ] Nenhum comando OPC UA direto foi implementado pelo gateway.
- [ ] Nenhum `PLC_ENDPOINT` foi adicionado.
- [ ] Nenhum reset de estoque ou comando de correção do HBW foi publicado.
- [ ] Nenhum arquivo de `plc_training_factory_24v` foi alterado.
