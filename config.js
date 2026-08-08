// config.js — Bot credentials come from environment variables (BOT_USERNAME,
// BOT_TOKEN, PORT). Set these on the host (local shell or your deploy platform)
// instead of committing secrets to the repo. See config.example.js for a template.

export const config = {
  botUsername: process.env.BOT_USERNAME || "",
  botToken: process.env.BOT_TOKEN || "",
  port: Number(process.env.PORT) || 3000,
};
