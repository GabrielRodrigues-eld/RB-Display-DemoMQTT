# Simulação da Factory 24 V

## Componentes

```text
Web App -> gateway -> Mosquitto 127.0.0.1:1883
                      ^                 |
                      |                 v
                      +------ fake factory
```

O broker não expõe WebSocket e não aceita interfaces remotas. Todos os publishes de
pedido e estado usam QoS 0. Pedidos e estados normais usam `retain=false`.

O simulador em `gateway/src/simulation/fake-factory.js` representa uma combinação
simplificada de Node-RED + PLC; não reimplementa OPC UA ou o PLC Siemens.
Ele recusa `MODE=factory` para evitar publicação simulada acidental na instalação
física.

## Inicialização

No connect, o simulador:

- assina `f/o/order`;
- publica `WAITING_FOR_ORDER`;
- publica nove posições de estoque, usando `id="0"`, `type=""`, `state=""` para
  vazios, como observado na fábrica física;
- publica hbw/vgr/mpo/sld/dsi/dso READY com `code=1`, `description=""`,
  `active=false` e `target=""`;
- republica snapshots no período configurado, sempre `retain=false` por padrão.

## Ciclo normal

1. valida objeto com exatamente `type` e `ts`;
2. exige WAITING_FOR_ORDER e estoque da cor;
3. publica ORDERED;
4. publica VGR/HBW BUSY;
5. publica IN_PROCESS e o repete aproximadamente a cada segundo;
6. publica SHIPPED somente se `SIMULATION_EMIT_SHIPPED=true`;
7. remove uma peça da cor e publica estoque;
8. retorna estações a READY;
9. publica WAITING_FOR_ORDER ao final.

`SIMULATION_SPEED=2` executa duas vezes mais rápido. O snapshot periódico é definido
por `SIMULATION_SNAPSHOT_PERIOD_MS`, cujo padrão é 2000 ms. O cenário normal usa
`SIMULATION_EMIT_SHIPPED=false`, mais fiel ao primeiro ciclo físico observado.
Ativar `true` mantém a variante oficial com SHIPPED.

## Cenários

| `SIMULATION_SCENARIO` | Efeito intencional |
|---|---|
| `normal` | Ciclo oficial simplificado |
| `no-stock` | Nove posições vazias; API bloqueia todas as cores |
| `slow-order` | ORDERED/transições demoram 12× e podem causar timeout |
| `drop-order` | Pedido é observado e descartado sem estado de retorno |
| `mqtt-disconnect` | Simulador encerra sua conexão ao receber pedido |
| `malformed-order-state` | Publica JSON inválido em f/i/order |
| `malformed-stock` | Publica JSON inválido em f/i/stock |
| `unknown-order-state` | Publica `MAINTENANCE`, que o gateway não normaliza |
| `station-error` | VGR é publicado com código ERROR |
| `duplicate-message` | Publica mensagens duas vezes |
| `retained-old-message` | Publica ORDERED antigo com retain=true para diagnóstico |
| `out-of-order-state` | Publica SHIPPED antes de ORDERED |
| `stale-stock` | Publica estoque inicial, depois deixa de atualizá-lo |

O cenário retained é deliberadamente não realista e existe para validar defesa. O
log informa explicitamente quando retain=true é uma decisão de simulação.

## Execução

```text
start-all-simulation.bat
```

Ou, em três terminais:

```text
tools\mosquitto\start-broker.bat
start-simulation.bat
start-gateway.bat
```

Para trocar cenário, edite `gateway/.env`, reinicie o simulador e o gateway:

```text
MODE=simulation
SIMULATION_SCENARIO=malformed-stock
SIMULATION_SPEED=1
SIMULATION_SNAPSHOT_PERIOD_MS=2000
SIMULATION_EMIT_SHIPPED=false
```

## Verificações manuais

- `/health`: gateway e MQTT online;
- `/api/state`: WAITING_FOR_ORDER e estoque válido;
- Web App: contador discreto do estoque lógico da cor selecionada;
- confirmar pedido e observar ORDERED, IN_PROCESS repetido e WAITING; SHIPPED
  aparece somente quando configurado;
- após WAITING, verificar liberação e redução do estoque;
- `/api/topics`: confirmar `f/o/order` outbound, QoS 0, retain false;
- `/api/events`: reconstruir a sequência completa, incluindo repetições;
- em cenário inválido, confirmar parse/schema error sem queda do processo.

## Teste automatizado

```powershell
npm --prefix gateway run test:integration
```

Ele cria configurações temporárias do Mosquitto em portas livres e valida dois
ciclos ponta a ponta: um sem SHIPPED e outro com SHIPPED. Em ambos, envia BLUE pela
API, observa o WebSocket, espera WAITING_FOR_ORDER e confirma a redução de estoque.
O teste é skipped quando o executável não existe.
