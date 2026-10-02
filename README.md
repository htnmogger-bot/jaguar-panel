# JAGUAR Panel + Discord (unificado)

Um único Web Service Node.js com:
- painel administrativo de licenças;
- bot Discord do projeto original;
- criação de PIX pela Revant Pay;
- webhook Revant Pay com idempotência;
- geração de licença no mesmo PostgreSQL usado pela API JAGUAR;
- DM da licença e cargo no Discord após pagamento aprovado.

## Deploy no Render
Build: `npm install`
Start: `npm start`

## Variáveis
Consulte `.env.example`. Segredos ficam somente nas Environment Variables do Render.
