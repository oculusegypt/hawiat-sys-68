<?php
declare(strict_types=1);

require __DIR__ . '/container-system.php';

function expectSame($expected, $actual, string $message): void {
    if ($expected !== $actual) {
        throw new RuntimeException($message . ': expected ' . var_export($expected, true) . ', got ' . var_export($actual, true));
    }
}

$pdo = new PDO('sqlite::memory:');
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

$methods = [
    ['نقدي', 'CASH-001'],
    ['نقد', 'CASH-001'],
    ['cash', 'CASH-001'],
    ['cash payment', 'CASH-001'],
    ['تحويل بنكي', 'BANK-001'],
    ['تحويل', 'BANK-001'],
    ['شبكة', 'BANK-001'],
    ['مدى', 'BANK-001'],
    ['فيزا', 'BANK-001'],
    ['ماستركارد', 'BANK-001'],
    ['Visa', 'BANK-001'],
    ['Mastercard', 'BANK-001'],
    ['Master card', 'BANK-001'],
    ['بطاقة', 'BANK-001'],
    ['POS', 'BANK-001'],
];

foreach ($methods as $index => [$method, $expectedAccount]) {
    $sourceId = 100 + $index;
    $payload = ['amount' => 10, 'paymentMethod' => $method, 'date' => '2026-10-12'];
    hsPostFinancialCore($pdo, 'payment', $sourceId, $payload, 'PAY-TEST-' . $sourceId, 1);
    $debit = $pdo->query("SELECT jl.account_code FROM financial_transactions ft
        JOIN financial_journal_entries je ON je.transaction_id = ft.id
        JOIN financial_journal_lines jl ON jl.journal_entry_id = je.id
        WHERE ft.source_kind = 'payment' AND ft.source_id = {$sourceId} AND jl.debit > 0")->fetchColumn();
    expectSame($expectedAccount, $debit, "Payment method {$method} must debit its settlement account");

    $returnId = 500 + $index;
    hsPostFinancialCore($pdo, 'payment_return', $returnId, $payload, 'RETURN-TEST-' . $returnId, 1);
    $credit = $pdo->query("SELECT jl.account_code FROM financial_transactions ft
        JOIN financial_journal_entries je ON je.transaction_id = ft.id
        JOIN financial_journal_lines jl ON jl.journal_entry_id = je.id
        WHERE ft.source_kind = 'payment_return' AND ft.source_id = {$returnId} AND jl.credit > 0")->fetchColumn();
    expectSame($expectedAccount, $credit, "Payment return method {$method} must credit the original settlement account");
}

$unknownRejected = false;
try {
    hsPostFinancialCore($pdo, 'payment', 9001, [
        'amount' => 10,
        'paymentMethod' => 'DEMO — no real payment',
        'date' => '2026-10-12',
    ], 'PAY-UNKNOWN-9001', 1);
} catch (RuntimeException $error) {
    $unknownRejected = true;
}
expectSame(true, $unknownRejected, 'Unknown payment methods must be rejected');
expectSame(0, (int)$pdo->query("SELECT COUNT(*) FROM financial_transactions WHERE source_id = 9001")->fetchColumn(), 'Rejected methods must not leave a financial transaction');

hsPostFinancialCore($pdo, 'receipt', 9002, [
    'amount' => 10,
    'sourcePaymentId' => 1,
], 'RCV-LINKED-9002', 1);
expectSame(0, (int)$pdo->query("SELECT COUNT(*) FROM financial_transactions WHERE source_id = 9002")->fetchColumn(), 'A receipt linked to a payment must not create a duplicate posting');

expectSame('draft', hsInitialFinancialStatus(''), 'New financial records default to draft');
expectSame('draft', hsInitialFinancialStatus('draft'), 'Draft may be selected at creation');
expectSame('pending_approval', hsInitialFinancialStatus('pending_approval'), 'Pending approval may be selected at creation');
expectSame('debit', hsLegacyLedgerDirection('bank_fee'), 'Bank fees must be represented as debits in the legacy ledger projection');
foreach (['approved', 'posted', 'rejected', 'cancelled', 'active'] as $invalidInitialStatus) {
    $statusRejected = false;
    try {
        hsInitialFinancialStatus($invalidInitialStatus);
    } catch (RuntimeException $error) {
        $statusRejected = true;
    }
    expectSame(true, $statusRejected, "Financial status {$invalidInitialStatus} must not be assigned at creation");
}

$depositId = 98901;
$depositPayload = ['amount' => 75, 'date' => '2026-10-12', 'reference' => 'TEST ONLY — deposit'];
hsPostFinancialCore($pdo, 'bank_deposit', $depositId, $depositPayload, 'TEST-DEPOSIT-98901', 1);
hsEnsureDepositReconciliation($pdo, $depositId, 'bank_deposit', $depositPayload, 'TEST-DEPOSIT-98901');
expectSame('unmatched', (string)$pdo->query(
    "SELECT status FROM bank_reconciliations WHERE deposit_record_id = {$depositId}"
)->fetchColumn(), 'posting a deposit must not imply that a bank statement confirmed it');

$identityPdo = new PDO('sqlite::memory:');
$identityPdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$identityPdo->exec("CREATE TABLE container_system_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, status TEXT NOT NULL,
    reference TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)");
$identityPdo->exec("CREATE TABLE service_requests (
    id INTEGER PRIMARY KEY, customer_record_id INTEGER, client_name TEXT, phone TEXT,
    email TEXT, service_type TEXT, location TEXT, created_at TEXT
)");
$existingProfile = json_encode([
    'name' => 'TEST ONLY — existing verified profile',
    'phone' => '966500000001',
    'email' => 'existing@example.invalid',
], JSON_UNESCAPED_UNICODE);
$insertExisting = $identityPdo->prepare("INSERT INTO container_system_records
    (kind,status,reference,payload,created_at,updated_at) VALUES ('customer','active','CUS-EXISTING-1',?,datetime('now'),datetime('now'))");
$insertExisting->execute([$existingProfile]);
$existingCustomerId = (int)$identityPdo->lastInsertId();
$identityPdo->exec("INSERT INTO service_requests
    (id,customer_record_id,client_name,phone,email,service_type,location,created_at)
    VALUES (77,NULL,'TEST ONLY — different requester','+966500000001',
        'new-inquiry@example.invalid','TEST ONLY — intake identity regression',
        'TEST ONLY — address submitted by unverified requester',datetime('now'))");

hsSyncRequestsToCustomers($identityPdo);
$linkedCustomerId = (int)$identityPdo->query("SELECT customer_record_id FROM service_requests WHERE id = 77")->fetchColumn();
expectSame(true, $linkedCustomerId > 0 && $linkedCustomerId !== $existingCustomerId,
    'PHP backfill must not merge an unverified phone into an existing customer');
expectSame($existingProfile, (string)$identityPdo->query(
    "SELECT payload FROM container_system_records WHERE id = {$existingCustomerId}"
)->fetchColumn(), 'PHP intake must leave a possible existing customer profile unchanged');
$provisional = json_decode((string)$identityPdo->query(
    "SELECT payload FROM container_system_records WHERE id = {$linkedCustomerId}"
)->fetchColumn(), true);
expectSame('unverified', $provisional['identityVerification'] ?? null,
    'PHP-created intake profiles must remain marked unverified');
expectSame('pending', $provisional['identityReviewStatus'] ?? null,
    'PHP-created intake profiles must require identity review');
$site = json_decode((string)$identityPdo->query(
    "SELECT payload FROM container_system_records WHERE kind = 'customer_site' AND reference = 'SITE-00077'"
)->fetchColumn(), true);
expectSame('TEST ONLY — address submitted by unverified requester', $site['address'] ?? null,
    'PHP intake must preserve the submitted test address in its own site record');
$identityPdo->exec("UPDATE service_requests SET customer_record_id = NULL WHERE id = 77");
hsSyncRequestsToCustomers($identityPdo);
expectSame(2, (int)$identityPdo->query("SELECT COUNT(*) FROM container_system_records WHERE kind = 'customer'")->fetchColumn(),
    'repeated PHP backfill must reuse request-specific customer records');
expectSame(1, (int)$identityPdo->query("SELECT COUNT(*) FROM container_system_records WHERE kind = 'customer_site'")->fetchColumn(),
    'repeated PHP backfill must reuse request-specific site records');

    $insertPostingFixture = static function(string $kind, string $status, array $payload) use ($identityPdo): int {
        $insert = $identityPdo->prepare("INSERT INTO container_system_records
            (kind,status,reference,payload,created_at,updated_at) VALUES (?,?,?,?,datetime('now'),datetime('now'))");
        $insert->execute([$kind, $status, 'TEST ONLY — financial posting invariant', json_encode($payload, JSON_UNESCAPED_UNICODE)]);
        return (int)$identityPdo->lastInsertId();
    };
    $originalPaymentId = $insertPostingFixture('payment', 'posted', ['amount' => 50]);
    $insertPostingFixture('payment_return', 'posted', ['amount' => 30, 'originalPaymentId' => $originalPaymentId]);
    $pendingReturnId = $insertPostingFixture('payment_return', 'approved', ['amount' => 30, 'originalPaymentId' => $originalPaymentId]);
    expectSame('قيمة مرتجع السداد تتجاوز قيمة السداد الأصلي',
        hsFinancialPostingInvariantIssue($identityPdo, 'payment_return', ['amount' => 30, 'originalPaymentId' => $originalPaymentId], $pendingReturnId),
        'PHP must recheck cumulative refunds against current posted records');
    expectSame(null,
        hsFinancialPostingInvariantIssue($identityPdo, 'payment_return', ['amount' => 20, 'originalPaymentId' => $originalPaymentId], $pendingReturnId),
        'PHP must permit an exact remaining-balance refund');

    $invoiceNumber = 'TEST ONLY — invoice return cap';
    $insertPostingFixture('invoice', 'posted', ['invoiceNumber' => $invoiceNumber, 'total' => 100]);
    $insertPostingFixture('invoice_return', 'posted', ['invoiceNumber' => $invoiceNumber, 'amount' => 60]);
    $pendingInvoiceReturnId = $insertPostingFixture('invoice_return', 'approved', ['invoiceNumber' => $invoiceNumber, 'amount' => 50]);
    expectSame('قيمة المرتجع تتجاوز الرصيد المتبقي من الفاتورة',
        hsFinancialPostingInvariantIssue($identityPdo, 'invoice_return', ['invoiceNumber' => $invoiceNumber, 'amount' => 50], $pendingInvoiceReturnId),
        'PHP must recheck cumulative invoice returns against current posted records');
    expectSame(null,
        hsFinancialPostingInvariantIssue($identityPdo, 'invoice_return', ['invoiceNumber' => $invoiceNumber, 'amount' => 40], $pendingInvoiceReturnId),
        'PHP must permit an invoice return within the remaining balance');

$contractA = [
    'id' => 41,
    'kind' => 'contract',
    'reference' => 'RNT-41',
    'payload' => json_encode(['customerRecordId' => 22, 'contractNumber' => 'RNT-41'], JSON_UNESCAPED_UNICODE),
];
$contractB = [
    'id' => 42,
    'kind' => 'contract',
    'reference' => 'RNT-42',
    'payload' => ['customerRecordId' => 33, 'contractNumber' => 'RNT-42'],
];
$invoiceA = [
    'id' => 71,
    'kind' => 'invoice',
    'reference' => 'INV-71',
    'payload' => json_encode([
        'customerRecordId' => 22,
        'contractRecordId' => 41,
        'contractNumber' => 'RNT-41',
        'invoiceNumber' => 'INV-DUP',
    ], JSON_UNESCAPED_UNICODE),
];
$invoiceB = [
    'id' => 72,
    'kind' => 'invoice',
    'reference' => 'INV-72',
    'payload' => [
        'customerRecordId' => 33,
        'contractRecordId' => 42,
        'contractNumber' => 'RNT-42',
        'invoiceNumber' => 'INV-DUP',
    ],
];
$relationRecords = [$contractA, $contractB, $invoiceA, $invoiceB];
expectSame(true, hsInvoiceBelongsToContract($invoiceA, $contractA),
    'PHP must match an invoice to its explicit contract and customer');
expectSame(false, hsInvoiceBelongsToContract($invoiceA, $contractB),
    'PHP must not match an invoice to another customer contract');
$mismatchedInvoice = $invoiceA;
$mismatchedInvoice['payload'] = ['customerRecordId' => 33, 'contractRecordId' => 41, 'contractNumber' => 'RNT-41'];
expectSame(false, hsInvoiceBelongsToContract($mismatchedInvoice, $contractA),
    'PHP must reject a customer mismatch even when an invoice has a direct contract ID');
$legacyPayment = [
    'id' => 81,
    'kind' => 'payment',
    'payload' => [
        'customerRecordId' => 22,
        'invoiceNumber' => 'INV-DUP',
        'allocations' => [['invoiceId' => 71, 'amount' => 45]],
    ],
];
expectSame(true, hsRecordReferencesContract($legacyPayment, $contractA, $relationRecords),
    'PHP must resolve invoice allocations to the invoice owner contract');
expectSame(false, hsRecordReferencesContract($legacyPayment, $contractB, $relationRecords),
    'PHP must not count an invoice allocation against another customer contract');
expectSame(45, (int)(hsFinancialAllocationForContract($legacyPayment, $contractA, $relationRecords)['amount'] ?? 0),
    'PHP must preserve the amount allocated through an invoice ID');

$settlementInvoice = [
    'id' => 91,
    'kind' => 'invoice',
    'status' => 'paid',
    'reference' => 'TEST-INVOICE-SETTLEMENT',
    'payload' => ['invoiceNumber' => 'TEST-INVOICE-SETTLEMENT', 'customerRecordId' => 22, 'total' => 100, 'paid' => 100, 'remaining' => 0, 'invoiceStatus' => 'paid'],
];
$settlementPayment = [
    'id' => 92,
    'kind' => 'payment',
    'status' => 'posted',
    'reference' => 'TEST-PAYMENT-SETTLEMENT',
    'payload' => ['customerRecordId' => 22, 'invoiceRecordId' => 91, 'amount' => 100],
];
$settlementReturn = [
    'id' => 93,
    'kind' => 'payment_return',
    'status' => 'posted',
    'reference' => 'TEST-RETURN-SETTLEMENT',
    'payload' => ['customerRecordId' => 22, 'originalPaymentId' => 92, 'amount' => 30],
];
$settlementRows = [$settlementInvoice, $settlementPayment, $settlementReturn];
$partialInvoiceSync = hsInvoiceSettlementUpdatesForRecord($settlementReturn, $settlementRows);
expectSame(1, count($partialInvoiceSync), 'posting a payment return must identify its linked invoice');
expectSame('partially_paid', $partialInvoiceSync[0]['status'],
    'posting a payment return must move a paid invoice back to partially paid');
expectSame(70, (int)$partialInvoiceSync[0]['payload']['paid'],
    'the stored invoice paid amount must reflect posted payment returns');
expectSame(30, (int)$partialInvoiceSync[0]['payload']['remaining'],
    'the stored invoice remaining amount must reflect posted payment returns');
$cancelledSettlementReturn = array_merge($settlementReturn, ['status' => 'cancelled']);
$staleInvoiceAfterReturn = array_merge($settlementInvoice, [
    'status' => 'partially_paid',
    'payload' => array_merge($settlementInvoice['payload'], [
        'paid' => 70,
        'remaining' => 30,
        'invoiceStatus' => 'partially_paid',
    ]),
]);
$cancelledInvoiceSync = hsInvoiceSettlementUpdatesForRecord($cancelledSettlementReturn, [
    $staleInvoiceAfterReturn,
    $settlementPayment,
    $cancelledSettlementReturn,
]);
expectSame('paid', $cancelledInvoiceSync[0]['status'],
    'cancelling a posted payment return must restore the invoice paid status');
expectSame(0, (int)$cancelledInvoiceSync[0]['payload']['remaining'],
    'cancelling a posted payment return must restore the invoice balance');

echo "PHP financial-method, invoice-relationship, and initial-status assertions passed\n";
