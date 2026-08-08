# config.example.js — copy this file to config.js and fill in your values for
# local development. When deploying, prefer environment variables:
#   BOT_USERNAME, BOT_TOKEN, PORT

export const config = {
  botUsername: "YOUR_BOT_USERNAME",
  botToken: "YOUR_BOT_TOKEN",
  port: Number(process.env.PORT) || 3000,
};
