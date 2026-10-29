import type { ContainerSystemRecord } from "@workspace/api-client-react"

const payloadOf = (record: ContainerSystemRecord) =>
  (record.payload ?? {}) as Record<string, unknown>

const nonEmpty = (...values: unknown[]) =>
  values.map(value => String(value ?? "").trim()).find(Boolean) ?? ""

export function contractDisplayNumber(contract: ContainerSystemRecord): string {
  const payload = payloadOf(contract)
  return nonEmpty(payload.contractNumber, payload.contractNo, contract.reference) || `#${contract.id}`
}

export function invoiceBelongsToContract(
  invoice: ContainerSystemRecord,
  contract: ContainerSystemRecord,
): boolean {
  if (invoice.kind !== "invoice" || contract.kind !== "contract") return false

  const invoicePayload = payloadOf(invoice)
  const contractPayload = payloadOf(contract)
  const invoiceCustomerId = Number(invoicePayload.customerRecordId ?? 0)
  const contractCustomerId = Number(contractPayload.customerRecordId ?? 0)

  if (invoiceCustomerId > 0 && contractCustomerId > 0 && invoiceCustomerId !== contractCustomerId) {
    return false
  }

  const linkedContractId = Number(
    invoicePayload.contractRecordId ?? invoicePayload.contractId ?? invoicePayload.linkedContractId ?? 0,
  )
  if (linkedContractId > 0) return linkedContractId === contract.id

  const invoiceNumber = nonEmpty(invoicePayload.contractNumber, invoicePayload.contractNo)
  const contractNumber = nonEmpty(contractPayload.contractNumber, contractPayload.contractNo, contract.reference)
  return Boolean(invoiceNumber && contractNumber && invoiceNumber === contractNumber)
}

export function invoiceContractForRecord(
  invoice: ContainerSystemRecord,
  contracts: ContainerSystemRecord[],
): ContainerSystemRecord | undefined {
  const invoicePayload = payloadOf(invoice)
  const linkedContractId = Number(
    invoicePayload.contractRecordId ?? invoicePayload.contractId ?? invoicePayload.linkedContractId ?? 0,
  )

  if (linkedContractId > 0) {
    const linkedContract = contracts.find(contract => contract.id === linkedContractId)
    return linkedContract && invoiceBelongsToContract(invoice, linkedContract) ? linkedContract : undefined
  }

  return contracts.find(contract => invoiceBelongsToContract(invoice, contract))
}

export function invoiceContractDisplayNumber(
  invoice: ContainerSystemRecord,
  contracts: ContainerSystemRecord[],
): string {
  const contract = invoiceContractForRecord(invoice, contracts)
  if (contract) return contractDisplayNumber(contract)

  const invoicePayload = payloadOf(invoice)
  return nonEmpty(invoicePayload.contractNumber, invoicePayload.contractNo) || "غير مرتبط"
}

export function paymentAmountForInvoice(
  payment: ContainerSystemRecord,
  invoice: ContainerSystemRecord,
  records: ContainerSystemRecord[],
): number {
  if (!["payment", "receipt"].includes(payment.kind) || payment.status !== "posted") return 0

  const paymentPayload = payloadOf(payment)
  const invoicePayload = payloadOf(invoice)
  const paymentCustomerId = Number(paymentPayload.customerRecordId ?? 0)
  const invoiceCustomerId = Number(invoicePayload.customerRecordId ?? 0)
  if (paymentCustomerId > 0 && invoiceCustomerId > 0 && paymentCustomerId !== invoiceCustomerId) return 0
  const contractMatchesPaymentCustomer = (contract: ContainerSystemRecord) => {
    const contractCustomerId = Number(payloadOf(contract).customerRecordId ?? 0)
    return paymentCustomerId <= 0 || contractCustomerId <= 0 || paymentCustomerId === contractCustomerId
  }

  const allocations = paymentPayload.allocations
  if (Array.isArray(allocations)) {
    return allocations.reduce((sum, entry) => {
      if (!entry || typeof entry !== "object") return sum
      const allocation = entry as Record<string, unknown>
      if (Number(allocation.invoiceId ?? 0) !== invoice.id) return sum
      const allocationContractId = Number(allocation.contractId ?? 0)
      if (allocationContractId > 0) {
        const contract = records.find(record => record.kind === "contract" && record.id === allocationContractId)
        if (!contract || !contractMatchesPaymentCustomer(contract) || !invoiceBelongsToContract(invoice, contract)) return sum
      }
      return sum + Number(allocation.amount ?? 0)
    }, 0)
  }

  const invoiceNumber = nonEmpty(invoicePayload.invoiceNumber, invoice.reference)
  const paymentInvoiceNumber = nonEmpty(paymentPayload.invoiceNumber)
  if (paymentInvoiceNumber && invoiceNumber && paymentInvoiceNumber !== invoiceNumber) return 0

  const paymentContractId = Number(
    paymentPayload.contractRecordId ?? paymentPayload.contractId ?? paymentPayload.linkedContractId ?? 0,
  )
  const paymentContractNumber = nonEmpty(paymentPayload.contractNumber)
  const recordsContract = paymentContractId > 0
    ? records.find(record => record.kind === "contract" && record.id === paymentContractId)
    : undefined
  if (paymentContractId > 0 &&
    (!recordsContract || !contractMatchesPaymentCustomer(recordsContract) || !invoiceBelongsToContract(invoice, recordsContract))) {
    return 0
  }
  if (recordsContract && (!contractMatchesPaymentCustomer(recordsContract) || !invoiceBelongsToContract(invoice, recordsContract))) return 0

  const directInvoiceId = Number(paymentPayload.invoiceRecordId ?? paymentPayload.invoiceId ?? 0)
  if (directInvoiceId > 0) {
    return directInvoiceId === invoice.id ? Number(paymentPayload.amount ?? 0) : 0
  }

  if (!paymentInvoiceNumber || !invoiceNumber || paymentInvoiceNumber !== invoiceNumber) return 0
  if (paymentContractNumber) {
    const matchingContracts = records.filter(record => {
      if (record.kind !== "contract") return false
      const payload = payloadOf(record)
      const number = nonEmpty(payload.contractNumber, payload.contractNo, record.reference)
      const customerId = Number(payload.customerRecordId ?? 0)
      return number === paymentContractNumber &&
        (paymentCustomerId <= 0 || customerId <= 0 || customerId === paymentCustomerId)
    })
    return matchingContracts.length === 1 && invoiceBelongsToContract(invoice, matchingContracts[0])
      ? Number(paymentPayload.amount ?? 0)
      : 0
  }

  const sameNumberInvoices = records.filter(record => {
    if (record.kind !== "invoice") return false
    const payload = payloadOf(record)
    if (nonEmpty(payload.invoiceNumber, record.reference) !== invoiceNumber) return false
    const customerId = Number(payload.customerRecordId ?? 0)
    return paymentCustomerId > 0
      ? customerId === paymentCustomerId
      : customerId <= 0
  })
  return sameNumberInvoices.length === 1 && sameNumberInvoices[0].id === invoice.id
    ? Number(paymentPayload.amount ?? 0)
    : 0
}
