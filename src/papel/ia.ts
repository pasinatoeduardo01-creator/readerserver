import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

export const MODELO_IA = "claude-opus-5";

export interface ParagrafoNumerado { texto: string }
export interface EntradaIA {
  chave: string;
  paragrafos: ParagrafoNumerado[];
  imagem?: { base64: string; mediaType: "image/jpeg" | "image/png" | "image/webp" };
  trecho?: string;
  idiomaLivro?: string | null;
}
export type ResultadoIA =
  | { status: "ok"; transcricao: string; paragrafo: number | null; confianca: number; candidatos: number[] }
  | { status: "erro"; mensagem: string };
export interface LocalizadorIA {
  localizar(entrada: EntradaIA): Promise<ResultadoIA>;
  testarChave(chave: string): Promise<{ ok: true } | { ok: false; mensagem: string }>;
}
export type FabricaCliente = (chave: string) => Pick<Anthropic, "messages" | "models">;

const Saida = z.object({
  transcricao: z.string(),
  paragrafo: z.number().int().nullable(),
  confianca: z.number().min(0).max(1),
  candidatos: z.array(z.number().int()),
});

const SISTEMA =
  "Você ajuda um leitor a sincronizar a leitura entre um livro de papel e o mesmo livro em EPUB. " +
  "Recebe uma foto de página ou um trecho digitado do livro de papel, que pode ser uma tradução para o português, " +
  "e a lista numerada dos parágrafos de um capítulo do EPUB. Responda só no formato pedido.";

function instrucao(entrada: EntradaIA): string {
  const alvo = entrada.imagem
    ? "Transcreva o texto legível da foto e identifique o parágrafo do EPUB em que a página fotografada COMEÇA (o primeiro parágrafo completo da página)."
    : `Trecho digitado pelo leitor: «${entrada.trecho}». Identifique o parágrafo do EPUB que contém esse trecho (ou a sua tradução).`;
  const lista = entrada.paragrafos.map((p, i) => `[${i + 1}] ${p.texto}`).join("\n");
  return (
    `${alvo}\n` +
    `Considere que o papel pode ser tradução (por exemplo, português) do EPUB${entrada.idiomaLivro ? ` (idioma do EPUB: ${entrada.idiomaLivro})` : ""}: compare pelo sentido, nomes próprios e números.\n` +
    `Devolva: "transcricao" (texto lido ou o trecho normalizado), "paragrafo" (número entre colchetes, ou null se não estiver neste capítulo), ` +
    `"confianca" (0 a 1) e "candidatos" (até 3 números possíveis, incluindo o escolhido, do mais provável ao menos).\n\n` +
    `Parágrafos do capítulo:\n${lista}`
  );
}

function mensagemDeErro(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "Chave de API inválida. Confira em Configurações.";
  if (e instanceof Anthropic.RateLimitError) return "Limite de uso da API atingido. Tente de novo em alguns instantes.";
  if (e instanceof Anthropic.APIError && (e.status === 402 || /credit|billing/i.test(e.message))) return "A conta da API está sem crédito.";
  if (e instanceof Anthropic.APIConnectionError) return "Não foi possível falar com a API. Verifique a conexão do servidor.";
  if (e instanceof Anthropic.APIError) return `A API respondeu com erro ${e.status ?? ""}: ${e.message}`;
  return "Erro inesperado ao chamar a IA.";
}

export function criarLocalizadorIA(fabrica: FabricaCliente = (chave) => new Anthropic({ apiKey: chave })): LocalizadorIA {
  return {
    async localizar(entrada) {
      if (!entrada.chave) return { status: "erro", mensagem: "Sem chave de API. Cadastre em Configurações." };
      if (!entrada.imagem && !entrada.trecho?.trim()) return { status: "erro", mensagem: "Envie uma foto ou digite um trecho." };
      if (entrada.paragrafos.length === 0) return { status: "erro", mensagem: "Este capítulo não tem texto." };
      const blocos: Anthropic.ContentBlockParam[] = [];
      if (entrada.imagem) {
        blocos.push({ type: "image", source: { type: "base64", media_type: entrada.imagem.mediaType, data: entrada.imagem.base64 } });
      }
      blocos.push({ type: "text", text: instrucao(entrada) });
      try {
        const cliente = fabrica(entrada.chave);
        const resposta = await cliente.messages.parse({
          model: MODELO_IA,
          // A transcrição de uma página inteira mais o raciocínio do "effort" cabem
          // com folga em 16 mil; em 2 mil a resposta era cortada e voltava vazia.
          max_tokens: 16000,
          system: SISTEMA,
          output_config: { format: zodOutputFormat(Saida), effort: "medium" },
          messages: [{ role: "user", content: blocos }],
        });
        if (resposta.stop_reason === "max_tokens") {
          return { status: "erro", mensagem: "A IA não terminou a resposta (limite de tamanho). Tente com um capítulo menor ou por texto." };
        }
        if (resposta.stop_reason === "refusal" || !resposta.parsed_output) {
          return { status: "erro", mensagem: "A IA não conseguiu localizar o trecho. Tente por texto ou marque o início do capítulo." };
        }
        const n = entrada.paragrafos.length;
        const valido = (x: number | null) => x !== null && Number.isInteger(x) && x >= 1 && x <= n;
        const saida = resposta.parsed_output;
        return {
          status: "ok",
          transcricao: saida.transcricao,
          paragrafo: valido(saida.paragrafo) ? (saida.paragrafo as number) - 1 : null,
          confianca: saida.confianca,
          candidatos: saida.candidatos.filter(valido).map((x) => x - 1).slice(0, 3),
        };
      } catch (e) {
        return { status: "erro", mensagem: mensagemDeErro(e) };
      }
    },
    async testarChave(chave) {
      if (!chave) return { ok: false, mensagem: "Informe a chave." };
      try {
        await fabrica(chave).models.retrieve(MODELO_IA);
        return { ok: true };
      } catch (e) {
        return { ok: false, mensagem: mensagemDeErro(e) };
      }
    },
  };
}
