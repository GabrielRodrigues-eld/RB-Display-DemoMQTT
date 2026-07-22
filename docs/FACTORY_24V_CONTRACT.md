# Contrato de integração — Training Factory 24 V

## Status da informação

Este contrato combina o repositório local de referência `plc_training_factory_24v`
com as observações realizadas na instalação física em 2026-07-22. Quando fonte e
campo diferem, a distinção é indicada explicitamente.

## Topologia observada e pendência

| Equipamento | Endereço de referência | Função |
|---|---|---|
| Roteador TP-Link | `192.168.0.1` | Roteador da instalação; não é o PLC |
| Connector OPC UA | `opc.tcp://192.168.0.1:4840` | Configurado no Node-RED, mas sem resposta no teste |
| Raspberry Pi | `192.168.0.5:1880` | Node-RED e dashboard confirmados |
| Broker MQTT | `192.168.0.10:1883` | Conexão confirmada sem credenciais no teste |
| PLC Siemens | desconhecido | Não inventar endereço; investigação externa pendente |

No notebook gateway, todos esses valores externos permanecem configuráveis. O
browser não conhece esses endereços.

## Pedido

Publicar em `f/o/order`, MQTT 3.1.1, QoS 0 e `retain=false`:

```json
{"type":"WHITE","ts":"2026-07-21T12:34:56.789Z"}
```

Regras:

- exatamente as chaves `type` e `ts`, nessa ordem na implementação atual;
- `type`: `WHITE`, `RED` ou `BLUE`;
- `ts`: por padrão, `new Date().toISOString()` gerado no gateway imediatamente antes
  do envio;
- não incluir `orderId`, `request`, `uid`, `workpiece`, quantidade ou outro campo;
- publicação única; sem fila offline e sem reenvio automático.

O Node-RED de referência recebe esse tópico e escreve `s_type` (String) e `ldt_ts`
(DateTime) no PLC por OPC UA. O PLC considera novo um timestamp maior que o último
aceito. Não há TTL de 10 segundos comprovado nesse caminho.

### Compatibilidade temporária de relógio

`ORDER_TIMESTAMP_OFFSET_MINUTES=0` é a política padrão e preserva UTC real. Se uma
medição em campo comprovar que o relógio interno da fábrica exige o comportamento
legado, `ORDER_TIMESTAMP_OFFSET_MINUTES=725` soma 12 h 05 min somente ao campo `ts`
publicado em `f/o/order`. É necessário reiniciar o gateway após alterar o `.env`.

A opção não muda o relógio do notebook, os horários locais de auditoria nem adiciona
campos ao payload industrial. Com offset não zero, o ISO ainda termina em `Z` por
compatibilidade, embora não represente UTC real; por isso o gateway emite alerta e
expõe o valor ativo em `/health` e `/api/state`. O offset deve voltar a `0` assim que
os relógios forem corrigidos ou a hipótese for descartada.

## Estado do pedido

Assinar `f/i/order`, QoS 0. Forma pretendida:

```json
{"ts":"2026-07-21T12:34:57.000Z","state":"ORDERED","type":"WHITE"}
```

Estados válidos e fluxo aceito:

```text
WAITING_FOR_ORDER -> ORDERED -> IN_PROCESS -> [SHIPPED opcional] -> WAITING_FOR_ORDER
```

Em `WAITING_FOR_ORDER`, `type` pode vir vazio. Nos demais estados, o gateway exige
WHITE/RED/BLUE. Estados desconhecidos e tipo inválido ficam em `/api/topics` como
diagnóstico e não substituem automaticamente o estado normalizado válido.

No primeiro pedido RED real, `ORDERED` apareceu uma vez, `IN_PROCESS` foi repetido
por vários minutos e `WAITING_FOR_ORDER` apareceu ao final. `SHIPPED` não foi
observado nessa execução, mas continua sendo um estado oficial conhecido. Repetições
são preservadas em `/api/events` sem duplicar transições locais.

## Estoque

Assinar `f/i/stock`:

```json
{
  "ts":"2026-07-21T12:34:50.000Z",
  "stockItems":[
    {"location":"A1","workpiece":{"id":"ABC","type":"WHITE","state":"RAW"}},
    {"location":"A2","workpiece":null},
    {"location":"A3","workpiece":{"id":"0","type":"","state":""}}
  ]
}
```

Posições: A1..A3, B1..B3 e C1..C3. Tipos conhecidos: NONE, WHITE, RED, BLUE.
Estados conhecidos: NONE, RAW, PROCESSED, REJECTED.

As duas formas de vazio acima são normalizadas para `workpiece: null`. O gateway
calcula contagens por cor, vazios e posições. Para aceitar pedido, exige
snapshot completo das nove posições, válido, consistente e não stale.
Essa é uma contagem lógica de `f/i/stock`, não uma inspeção física.

## Estações

Assinatura padrão: `f/i/state/+`.

```json
{"ts":"...","station":"hbw","code":1,"description":"","active":false,"target":""}
```

| Código | Estado normalizado |
|---:|---|
| 0 | OFF |
| 1 | READY |
| 2 | BUSY |
| 3 | WAIT_READY |
| 4 | ERROR |
| 6 | WAIT_ERROR |
| 7 | CALIBRATION |

Estações esperadas no MVP: hbw, vgr, mpo, sld, dsi e dso. `active` aceita boolean
ou 0/1, mas não define READY/BUSY; `code` é a autoridade. `description` e `target`
podem ser strings vazias. Os valores brutos permanecem no diagnóstico.

## Observabilidade adicional

Leitura preparada para `i/broadcast`, `i/bme680`, `i/ldr`, `i/alert`, `i/ptu/pos`,
`f/i/nfc/ds` e `f/i/alert`. `i/cam` fica desligado por padrão pelo volume.

O gateway não publica em `fl/#`, `f/o/state/ack`, `f/o/nfc/ds`, `o/ptu` ou `c/#`.
Ele também rejeita esses prefixos em assinaturas extras quando aplicável.

## Máquina local e segurança contra duplicidade

Antes do POST:

1. `FACTORY_COMMANDS_ENABLED=true` explicitamente;
2. MQTT conectado;
3. tipo válido;
4. nenhum pedido pendente;
5. fábrica válida em WAITING_FOR_ORDER;
6. estoque completo, recente e consistente;
7. pelo menos uma peça da cor.

Depois do publish:

```text
submitting -> awaiting_ordered -> ordered -> in_process
           -> [shipped -> awaiting_ready] -> idle
```

`idle` retorna quando WAITING_FOR_ORDER é observado depois de ORDERED/IN_PROCESS,
com ou sem SHIPPED. A conclusão sem SHIPPED registra
`completedWithoutShipped=true`. Timeout de ORDERED vira `uncertain`, não publica de
novo e mantém o pedido para reconciliação.

### Bootstrap silencioso de standby

Como `f/i/order` usa QoS 0, `retain=false` e publica por mudança, um gateway que se
conecta com a fábrica já parada não recebe snapshot inicial. A inferência opcional
`FACTORY_INFER_WAITING_ON_BOOT=true` espera a janela configurada e exige estoque
válido/recente, as seis estações recentes com `code=1`, ausência de pedido pendente
e nenhum `f/i/order` na sessão. O resultado é explicitamente marcado como inferido.
Qualquer evento real bloqueia ou substitui a inferência; reconexão descarta todas as
evidências da sessão anterior.
