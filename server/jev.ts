import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import type { JevKind, JevResult } from "../shared/types.ts";

const KINDS = new Set<JevKind>([
  "invoice",
  "customer_or_financial_data",
  "work_document",
  "personal_reference",
  "disposable_download",
  "other",
]);

let client: TypeSafeClient | null = null;

export function jevConfigured(): boolean {
  return Boolean(process.env.TYPESAFE_API_KEY);
}

export async function classifyDocument(state: { [key: string]: string | number | null }): Promise<JevResult> {
  const response = await getClient().systemOne({
    state,
    questions: {
      kind: choice("What kind of file is this, based on the file name and text sample?", {
        invoice: "A bill, invoice, receipt, or payment request",
        customer_or_financial_data:
          "A customer export, database, spreadsheet of people, tax document, contract, or other financial or customer record",
        work_document: "A work or project document that is not obviously disposable",
        personal_reference: "A guide, ebook, or other personal reference the person might want to keep",
        disposable_download: "A leftover download with no lasting value that is safe to delete",
        other: "None of the above",
      }),
      sensitive: noul(
        "The text sample contains personal, customer, or financial data such as names with amounts, account details, invoices, or private records",
      ),
      loss: score("How costly would it be to lose this file permanently?", [
        "Nothing important. It is disposable or easy to download again.",
        "Inconvenient. It would take a little effort to replace.",
        "Hard to replace. It is a real document or record.",
        "Irreplaceable. It is unique personal or work data.",
      ]),
    },
  });

  const kindAnswer = response.answers.kind;
  const lossAnswer = response.answers.loss;
  return {
    kind: asKind(kindAnswer.choice),
    kindConfidence: typeof kindAnswer.confidence === "number" ? kindAnswer.confidence : 0,
    sensitive: response.answers.sensitive.noul,
    loss: lossAnswer.score,
  };
}

function getClient(): TypeSafeClient {
  if (!client) client = new TypeSafeClient({ defaultModel: "jev-latest" });
  return client;
}

function asKind(value: string): JevKind {
  return KINDS.has(value as JevKind) ? (value as JevKind) : "other";
}

export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/sk-[a-zA-Z0-9_-]+/g, "sk-…").slice(0, 180);
}
