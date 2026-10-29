import assert from "node:assert/strict"
import test from "node:test"
import type { ContainerSystemRecord } from "@workspace/api-client-react"
import {
  invoiceBelongsToContract,
  paymentAmountForInvoice,
} from "./containerFinancialRelations"

const record = (
  id: number,
  kind: string,
  payload: Record<string, unknown>,
  status = "posted",
) => ({
  id,
  kind,
  status,
  payload,
  reference: "",
  createdAt: "",
  updatedAt: "",
} as ContainerSystemRecord)

test("invoice relationship rejects a customer mismatch even with a direct contract ID", () => {
  const contract = record(10, "contract", { customerRecordId: 1, contractNumber: "C-10" })
  const invoice = record(20, "invoice", {
    customerRecordId: 2,
    contractRecordId: 10,
    contractNumber: "C-10",
  })

  assert.equal(invoiceBelongsToContract(invoice, contract), false)
})

test("legacy invoice-number payments only count for the matching customer and contract", () => {
  const contractA = record(10, "contract", { customerRecordId: 1, contractNumber: "C-10" })
  const contractB = record(11, "contract", { customerRecordId: 2, contractNumber: "C-11" })
  const invoiceA = record(20, "invoice", {
    customerRecordId: 1,
    contractRecordId: 10,
    contractNumber: "C-10",
    invoiceNumber: "INV-1",
  })
  const invoiceB = record(21, "invoice", {
    customerRecordId: 2,
    contractRecordId: 11,
    contractNumber: "C-11",
    invoiceNumber: "INV-1",
  })
  const paymentA = record(30, "payment", {
    customerRecordId: 1,
    contractRecordId: 10,
    invoiceNumber: "INV-1",
    amount: 40,
  })
  const records = [contractA, contractB, invoiceA, invoiceB, paymentA]

  assert.equal(paymentAmountForInvoice(paymentA, invoiceA, records), 40)
  assert.equal(paymentAmountForInvoice(paymentA, invoiceB, records), 0)
})

test("multi-contract allocations use their own invoice IDs, not the payment's first contract", () => {
  const contractA = record(10, "contract", { customerRecordId: 1, contractNumber: "C-10" })
  const contractB = record(11, "contract", { customerRecordId: 1, contractNumber: "C-11" })
  const invoiceA = record(20, "invoice", {
    customerRecordId: 1,
    contractRecordId: 10,
    contractNumber: "C-10",
    invoiceNumber: "INV-1",
  })
  const invoiceB = record(21, "invoice", {
    customerRecordId: 1,
    contractRecordId: 11,
    contractNumber: "C-11",
    invoiceNumber: "INV-2",
  })
  const payment = record(30, "payment", {
    customerRecordId: 1,
    contractRecordId: 10,
    contractNumber: "C-10",
    invoiceNumber: "INV-1",
    allocations: [
      { contractId: 10, invoiceId: 20, amount: 5 },
      { contractId: 11, invoiceId: 21, amount: 7 },
    ],
  })
  const records = [contractA, contractB, invoiceA, invoiceB, payment]

  assert.equal(paymentAmountForInvoice(payment, invoiceA, records), 5)
  assert.equal(paymentAmountForInvoice(payment, invoiceB, records), 7)
})

test("ambiguous legacy invoice numbers do not attribute a payment to either invoice", () => {
  const invoiceA = record(20, "invoice", { invoiceNumber: "INV-DUP" })
  const invoiceB = record(21, "invoice", { invoiceNumber: "INV-DUP" })
  const payment = record(30, "payment", { invoiceNumber: "INV-DUP", amount: 40 })
  const records = [invoiceA, invoiceB, payment]

  assert.equal(paymentAmountForInvoice(payment, invoiceA, records), 0)
  assert.equal(paymentAmountForInvoice(payment, invoiceB, records), 0)
})
