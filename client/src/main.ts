import { IdleverseGame } from "./game/IdleverseGame";

const app = document.getElementById("app");
if (!app) throw new Error("Missing #app root");

const game = new IdleverseGame(app);
game.start();

if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => {
    game.dispose();
    app.innerHTML = "";
  });
}
