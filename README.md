# JAGUAR PANEL + BOT

Painel administrativo, bot Discord e integração de pagamentos Revant Pay no mesmo serviço.

## Post de venda
Administradores podem usar `/post-venda` no canal desejado para publicar um anúncio com:
- produto;
- título e descrição;
- preço antigo;
- preço promocional;
- desconto percentual calculado automaticamente;
- até duas imagens por URL HTTPS;
- botão de compra.

O botão cria o PIX diretamente para o usuário e vincula a cobrança ao Discord.

## Variáveis
DATABASE_URL, PANEL_PASSWORD, SESSION_SECRET, BOT_API_SECRET, REVANTPAY_API_KEY, DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID, DISCORD_ROLE_ID e PUBLIC_BASE_URL.
