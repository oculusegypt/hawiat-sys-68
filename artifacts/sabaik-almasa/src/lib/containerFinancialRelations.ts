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

function canonicalCollections(records: ContainerSystemRecord[]) {
  const payments = records.filter(record => record.kind === "payment" && record.status === "posted")
  const paymentKeys = new Set(payments.map(record => {
    const payload = payloadOf(record)
    return [
      payload.customerRecordId ?? "",
      payload.contractRecordId ?? payload.contractNumber ?? "",
      payload.invoiceRecordId ?? payload.invoiceNumber ?? "",
      payload.amount ?? payload.total ?? "",
      payload.date ?? "",
    ].join("|")
  }))
  return [
    ...payments,
    ...records.filter(record => {
      if (record.kind !== "receipt" || record.status !== "posted") return false
      const payload = payloadOf(record)
      const key = [
        payload.customerRecordId ?? "",
        payload.contractRecordId ?? payload.contractNumber ?? "",
        payload.invoiceRecordId ?? payload.invoiceNumber ?? "",
        payload.amount ?? payload.total ?? "",
        payload.date ?? "",
      ].join("|")
      return !payload.sourcePaymentId && !paymentKeys.has(key)
    }),
  ]
}

function invoiceReturnBelongsToInvoice(
  returned: ContainerSystemRecord,
  invoice: ContainerSystemRecord,
  records: ContainerSystemRecord[],
) {
  const payload = payloadOf(returned)
  const returnCustomerId = Number(payload.customerRecordId ?? 0)
  const invoiceCustomerId = Number(payloadOf(invoice).customerRecordId ?? 0)
  if (returnCustomerId > 0 && invoiceCustomerId > 0 && returnCustomerId !== invoiceCustomerId) return false

  const returnContractId = Number(
    payload.contractRecordId ?? payload.contractId ?? payload.linkedContractId ?? 0,
  )
  if (returnContractId > 0) {
    const contract = records.find(record => record.kind === "contract" && record.id === returnContractId)
    if (!contract || !invoiceBelongsToContract(invoice, contract)) return false
    const contractCustomerId = Number(payloadOf(contract).customerRecordId ?? 0)
    if (returnCustomerId > 0 && contractCustomerId > 0 && returnCustomerId !== contractCustomerId) return false
  }
  return true
}

export function paymentReturnAmountForInvoice(
  returned: ContainerSystemRecord,
  invoice: ContainerSystemRecord,
  records: ContainerSystemRecord[],
): number {
  if (returned.kind !== "payment_return" || returned.status !== "posted" || invoice.kind !== "invoice") return 0
  if (!invoiceReturnBelongsToInvoice(returned, invoice, records)) return 0

  const payload = payloadOf(returned)
  const amount = Number(payload.amount ?? payload.total ?? 0)
  if (!Number.isFinite(amount) || amount <= 0) return 0

  const allocations = Array.isArray(payload.allocations) ? payload.allocations : []
  const allocationInvoiceIds = allocations
    .filter(entry => entry && typeof entry === "object")
    .map(entry => Number((entry as Record<string, unknown>).invoiceId ?? 0))
    .filter(id => id > 0)
  if (allocationInvoiceIds.length > 0) {
    return allocations.reduce((sum, entry) => {
      if (!entry || typeof entry !== "object") return sum
      const allocation = entry as Record<string, unknown>
      if (Number(allocation.invoiceId ?? 0) !== invoice.id) return sum
      const contractId = Number(allocation.contractId ?? 0)
      if (contractId > 0) {
        const contract = records.find(record => record.kind === "contract" && record.id === contractId)
        if (!contract || !invoiceBelongsToContract(invoice, contract)) return sum
      }
      return sum + Math.max(Number(allocation.amount ?? 0), 0)
    }, 0)
  }

  const directInvoiceId = Number(
    payload.invoiceRecordId ?? payload.originalInvoiceId ?? payload.invoiceId ?? 0,
  )
  if (directInvoiceId > 0) return directInvoiceId === invoice.id ? amount : 0

  const originalPaymentId = Number(payload.originalPaymentId ?? payload.sourcePaymentId ?? 0)
  if (originalPaymentId > 0) {
    const originalPayment = records.find(record =>
      ["payment", "receipt"].includes(record.kind) &&
      record.status === "posted" &&
      record.id === originalPaymentId,
    )
    if (!originalPayment) return 0
    const invoicePaidFromOriginal = paymentAmountForInvoice(originalPayment, invoice, records)
    if (invoicePaidFromOriginal <= 0) return 0

    const originalPayload = payloadOf(originalPayment)
    const originalAllocations = Array.isArray(originalPayload.allocations)
      ? originalPayload.allocations.filter(entry => entry && typeof entry === "object") as Record<string, unknown>[]
      : null
    if (originalAllocations) {
      const invoiceAllocationIds = [...new Set(originalAllocations
        .map(allocation => Number(allocation.invoiceId ?? 0))
        .filter(id => id > 0))]
      const allAllocationsTargetThisInvoice = invoiceAllocationIds.length === 1 &&
        invoiceAllocationIds[0] === invoice.id &&
        originalAllocations.every(allocation => Number(allocation.invoiceId ?? 0) === invoice.id)
      const originalTotal = Number(originalPayload.amount ?? originalPayload.total ?? 0)
      if (!allAllocationsTargetThisInvoice && amount + 0.01 < originalTotal) return 0
    }
    return Math.min(amount, invoicePaidFromOriginal)
  }

  const returnInvoiceNumber = nonEmpty(payload.invoiceNumber, payload.originalInvoiceNumber)
  const invoicePayload = payloadOf(invoice)
  const invoiceNumber = nonEmpty(invoicePayload.invoiceNumber, invoice.reference)
  if (!returnInvoiceNumber || returnInvoiceNumber !== invoiceNumber) return 0
  const returnContractNumber = nonEmpty(payload.contractNumber)
  const returnCustomerId = Number(payload.customerRecordId ?? 0)
  const matchingInvoices = records.filter(candidate => {
    if (candidate.kind !== "invoice") return false
    const candidatePayload = payloadOf(candidate)
    if (nonEmpty(candidatePayload.invoiceNumber, candidate.reference) !== returnInvoiceNumber) return false
    const candidateCustomerId = Number(candidatePayload.customerRecordId ?? 0)
    if (returnCustomerId > 0 && candidateCustomerId !== returnCustomerId) return false
    if (returnContractNumber) {
      const contracts = records.filter(contract =>
        contract.kind === "contract" &&
        contractDisplayNumber(contract) === returnContractNumber &&
        (returnCustomerId <= 0 || Number(payloadOf(contract).customerRecordId ?? 0) === returnCustomerId),
      )
      return contracts.length === 1 && invoiceBelongsToContract(candidate, contracts[0])
    }
    return true
  })
  return matchingInvoices.length === 1 && matchingInvoices[0].id === invoice.id ? amount : 0
}

export function invoiceFinancialEntries(
  invoice: ContainerSystemRecord,
  records: ContainerSystemRecord[],
) {
  const collections = canonicalCollections(records)
    .map(record => ({ record, amount: paymentAmountForInvoice(record, invoice, records) }))
    .filter(entry => entry.amount > 0)
  const returns = records
    .filter(record => record.kind === "payment_return" && record.status === "posted")
    .map(record => ({
      record,
      amount: paymentReturnAmountForInvoice(record, invoice, records),
    }))
    .filter(entry => entry.amount > 0)
  return [...collections, ...returns]
}

export function invoiceNetPaidAmount(
  invoice: ContainerSystemRecord,
  records: ContainerSystemRecord[],
): number {
  const net = invoiceFinancialEntries(invoice, records).reduce(
    (sum, entry) => sum + (entry.record.kind === "payment_return" ? -entry.amount : entry.amount),
    0,
  )
  return Math.max(net, 0)
}
