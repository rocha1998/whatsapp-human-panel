# WhatsApp Human Panel

Painel multi-cliente para atendimento **humano** usando a **WhatsApp Cloud API oficial da Meta**.

## O que já está pronto

- Login administrativo
- Cadastro de vários clientes/números
- Token da Meta criptografado no banco
- Webhook GET para verificação da Meta
- Webhook POST para receber mensagens
- Identificação automática do cliente pelo `phone_number_id`
- Contatos, conversas, não lidas e histórico
- Resposta manual pelo painel
- Atualização básica de status de mensagens
- Filtro por cliente e busca por nome/telefone
- Encerrar conversa

## 1. Banco PostgreSQL

Crie um banco e execute:

```bash
psql "$DATABASE_URL" -f sql/schema.sql
```

Ou abra `sql/schema.sql` no pgAdmin e execute.

## 2. Instalação

```bash
npm install
cp .env.example .env
```

No Windows, copie `.env.example` para `.env` manualmente.

## 3. Gere a chave de criptografia

No terminal Node:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Cole o resultado em `APP_ENCRYPTION_KEY`.

## 4. Crie o administrador

Defina `ADMIN_EMAIL` e `ADMIN_PASSWORD` no `.env`, depois:

```bash
npm run seed:admin
```

## 5. Inicie

```bash
npm run dev
```

Abra `http://localhost:3000`.

## 6. Webhook da Meta

A Meta precisa alcançar uma URL HTTPS pública. Em produção, use algo como:

```text
https://seu-dominio.com/webhook
```

Use no campo **Verify Token** exatamente o mesmo valor de `META_VERIFY_TOKEN`.

Depois assine o campo `messages` no webhook do WhatsApp.

## 7. Adicione cada cliente

No painel, abra **Clientes** e informe:

- Nome do cliente
- Phone Number ID
- WhatsApp Business Account ID (WABA ID)
- Access Token

Nunca coloque o token no frontend, em GitHub público ou em prints.

## 8. Atendimento

Quando alguém mandar mensagem para um dos números cadastrados, a conversa aparece no painel. Abra e responda.

### Regra importante da Meta

Mensagens livres normalmente devem respeitar a janela de atendimento iniciada pelo usuário. Fora da janela permitida pela Meta, use um **template aprovado**. Este projeto não tenta contornar essa regra; a própria API pode recusar envios fora da política.

## Produção

Antes de usar comercialmente, recomenda-se:

- HTTPS obrigatório
- Criar a tabela de sessões PostgreSQL conforme a preparação abaixo
- CSRF e rate limit no painel
- Usuários separados para cada atendente
- Auditoria de quem respondeu cada mensagem
- Backups do PostgreSQL
- Token permanente via System User/Business Manager quando aplicável
- Política de privacidade e controles de acesso

## Preparação para Render e sessões PostgreSQL

As sessões usam `connect-pg-simple` com o pool existente de `src/db.js` e a
tabela `public.user_sessions`. Não há fallback para MemoryStore nem criação
automática da tabela (`createTableIfMissing: false`).

Antes de utilizar o login, um responsável deve revisar e executar explicitamente
`sql/session.sql` no banco de destino, em uma etapa autorizada. A instalação de
dependências e a inicialização do servidor não executam esse SQL. Ele cria somente
a tabela de sessões (`sid`, `sess`, `expire`) e o índice de expiração; não altera
as tabelas de atendimento. O usuário da aplicação precisa de SELECT, INSERT,
UPDATE e DELETE nessa tabela. Se ela já existir, confirme sua estrutura antes de
prosseguir: `IF NOT EXISTS` não corrige uma tabela incompatível.

O cookie e a sessão têm duração de 8 horas, renovada com a atividade autenticada
(`rolling: true`). O adaptador remove sessões expiradas periodicamente. Reinícios
e instâncias distintas preservam o login quando usam o mesmo banco e o mesmo
`SESSION_SECRET`. Sessões antigas do MemoryStore não são migradas.

Configuração a preparar no Render, sem enviar o `.env`:

- `NODE_ENV=production`.
- `DATABASE_URL` do PostgreSQL de destino e `SESSION_SECRET` forte e estável.
- As demais variáveis já utilizadas: `APP_ENCRYPTION_KEY`, `META_APP_SECRET`,
  `META_VERIFY_TOKEN` e `META_GRAPH_VERSION`.
- Comando de instalação: `npm ci`; inicialização: `npm start`.
- Diretório raiz do serviço: o diretório que contém `package.json`.
- Health check: `/health`. A aplicação respeita `process.env.PORT`.

Em produção, `trust proxy` é configurado como `1` antes da sessão e o cookie usa
`Secure`, `HttpOnly` e `SameSite=Lax`. Isso permite reconhecer HTTPS terminado no
proxy. Essa confiança pressupõe o proxy controlando os cabeçalhos encaminhados;
mudanças na topologia de proxies exigem revisão. Localmente, use
`NODE_ENV=development` para login por HTTP. Não exponha uma instância de teste que
confie em cabeçalhos de proxy enviados diretamente por clientes.

`GET /health` é público e retorna somente HTTP 200 com `{"ok":true}`, antes dos
parsers, da sessão e da autenticação. Não consulta PostgreSQL nem cria cookie.
Ele verifica a resposta HTTP do processo, não a disponibilidade do banco ou login.
Um health check positivo não substitui a criação da tabela e os testes de sessão.

`SESSION_SECRET` continua obrigatório, sem valor padrão. Não registre cookies,
sessões ou credenciais nos logs. A configuração TLS atual de `src/db.js` não foi
alterada nesta etapa e deve ser revisada antes de produção.

### Testes antes do deploy

Testes sem banco real podem usar o Express, o middleware e o adaptador reais com
um pool PostgreSQL simulado e variáveis fictícias apenas no processo de teste:

- Verificar sintaxe, configuração obrigatória e ausência de fallback.
- Consultar `/health` sem cookie e com cookie inválido, inclusive com o pool
  indisponível: esperar o JSON exato, sem redirecionamento, cookie ou consulta.
- Simular login em HTTP de desenvolvimento e HTTPS encaminhado pelo proxy em
  produção; verificar os atributos do cookie e o acesso autenticado subsequente.
- Confirmar que HTTP em produção não emite cookie seguro.
- Simular duas instâncias, reinício, logout, expiração e falhas de persistência.
- Verificar a renovação e duração de 8 horas sem imprimir cookies ou dados.

Para comprovar persistência em PostgreSQL real, será necessária uma etapa
separadamente autorizada em banco de teste, com `sql/session.sql` e usuário de
teste. Após login, reinicie a aplicação e verifique a mesma sessão; teste outra
instância, logout e expiração. Não execute esses testes no banco real de operação
nem modifique silenciosamente o `.env`. Nenhum teste exige envio à Meta.

## Estrutura

```text
src/
  routes/
    auth.js
    panel.js
    webhook.js
  services/
    meta.js
  middleware/
    auth.js
  utils/
    crypto.js
  views/
  public/
  db.js
  seed-admin.js
  server.js
sql/schema.sql
sql/session.sql
```
