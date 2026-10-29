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
