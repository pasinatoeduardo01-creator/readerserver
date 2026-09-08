import { test, expect } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { criarLocalizadorIA, MODELO_IA, type FabricaCliente } from "./ia";

function fabricaFalsa(resposta: any, capturar: { req?: any } = {}, erro?: Error): FabricaCliente {
  return () =>
    ({
      messages: {
        parse: async (req: any) => {
          capturar.req = req;
          if (erro) throw erro;
          return resposta;
        },
      },
      models: { retrieve: async () => { if (erro) throw erro; return { id: MODELO_IA }; } },
    }) as any;
}

const paragrafos = [{ texto: "Primeiro." }, { texto: "Segundo parágrafo." }, { texto: "Terceiro." }];

test("monta a requisição com imagem, parágrafos numerados e esquema, e converte o número para índice", async () => {
  const cap: { req?: any } = {};
  const ia = criarLocalizadorIA(fabricaFalsa({ stop_reason: "end_turn", parsed_output: { transcricao: "Segundo par", paragrafo: 2, confianca: 0.9, candidatos: [2, 3] } }, cap));
  const r = await ia.localizar({ chave: "k", paragrafos, imagem: { base64: "AAAA", mediaType: "image/jpeg" } });
  expect(r).toEqual({ status: "ok", transcricao: "Segundo par", paragrafo: 1, confianca: 0.9, candidatos: [1, 2] });
  expect(cap.req.model).toBe(MODELO_IA);
  expect(cap.req.output_config.format).toBeDefined();
  const blocos = cap.req.messages[0].content;
  expect(blocos[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } });
  expect(blocos[1].text).toContain("[2] Segundo parágrafo.");
});

test("trecho digitado vai como texto, sem bloco de imagem", async () => {
  const cap: { req?: any } = {};
  const ia = criarLocalizadorIA(fabricaFalsa({ stop_reason: "end_turn", parsed_output: { transcricao: "x", paragrafo: 3, confianca: 0.8, candidatos: [] } }, cap));
  await ia.localizar({ chave: "k", paragrafos, trecho: "Terceiro" });
  expect(cap.req.messages[0].content[0].type).toBe("text");
  expect(cap.req.messages[0].content[0].text).toContain("Terceiro");
});

test("paragrafo null, número fora da faixa ou recusa viram resultado sem parágrafo ou erro", async () => {
  const ia1 = criarLocalizadorIA(fabricaFalsa({ stop_reason: "end_turn", parsed_output: { transcricao: "", paragrafo: null, confianca: 0, candidatos: [] } }));
  expect(await ia1.localizar({ chave: "k", paragrafos, trecho: "?" })).toMatchObject({ status: "ok", paragrafo: null });
  const ia2 = criarLocalizadorIA(fabricaFalsa({ stop_reason: "end_turn", parsed_output: { transcricao: "", paragrafo: 99, confianca: 1, candidatos: [0, 99] } }));
  expect(await ia2.localizar({ chave: "k", paragrafos, trecho: "?" })).toMatchObject({ status: "ok", paragrafo: null, candidatos: [] });
  const ia3 = criarLocalizadorIA(fabricaFalsa({ stop_reason: "refusal", parsed_output: null }));
  expect(await ia3.localizar({ chave: "k", paragrafos, trecho: "?" })).toMatchObject({ status: "erro" });
});

test("resposta cortada pelo limite de tamanho vira mensagem própria; o limite é 16 mil", async () => {
  const cap: { req?: any } = {};
  const ia = criarLocalizadorIA(fabricaFalsa({ stop_reason: "max_tokens", parsed_output: null }, cap));
  expect(await ia.localizar({ chave: "k", paragrafos, trecho: "x" })).toEqual({
    status: "erro",
    mensagem: "A IA não terminou a resposta (limite de tamanho). Tente com um capítulo menor ou por texto.",
  });
  expect(cap.req.max_tokens).toBe(16000);
});

test("erros da API viram mensagens em português", async () => {
  const auth = new Anthropic.AuthenticationError(401, {}, "bad key", new Headers());
  const ia = criarLocalizadorIA(fabricaFalsa(null, {}, auth));
  expect(await ia.localizar({ chave: "k", paragrafos, trecho: "x" })).toEqual({ status: "erro", mensagem: "Chave de API inválida. Confira em Configurações." });
  expect(await ia.testarChave("k")).toEqual({ ok: false, mensagem: "Chave de API inválida. Confira em Configurações." });
});

test("sem chave, nem imagem nem trecho: erro sem chamar a rede", async () => {
  let chamou = false;
  const ia = criarLocalizadorIA(() => { chamou = true; return {} as any; });
  expect(await ia.localizar({ chave: "", paragrafos, trecho: "x" })).toMatchObject({ status: "erro" });
  expect(await ia.localizar({ chave: "k", paragrafos })).toMatchObject({ status: "erro" });
  expect(chamou).toBe(false);
});

test("testarChave devolve ok quando o modelo é encontrado", async () => {
  const ia = criarLocalizadorIA(fabricaFalsa(null));
  expect(await ia.testarChave("k")).toEqual({ ok: true });
});
