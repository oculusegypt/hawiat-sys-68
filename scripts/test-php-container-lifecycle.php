<?php
declare(strict_types=1);

require __DIR__ . '/container-system.php';

function lifecycleExpectSame($expected, $actual, string $message): void {
    if ($expected !== $actual) {
        throw new RuntimeException($message . ': expected ' . var_export($expected, true) . ', got ' . var_export($actual, true));
    }
}

function lifecycleExpectFailure(callable $callback, int $expectedCode, string $message): void {
    try {
        $callback();
    } catch (RuntimeException $error) {
        lifecycleExpectSame($expectedCode, (int)$error->getCode(), $message);
        return;
    }
    throw new RuntimeException($message . ': operation unexpectedly succeeded');
}

$pdo = new PDO('sqlite::memory:');
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
hsPrepareServiceRequestsTable($pdo);
$serviceRequestColumns = array_column($pdo->query("PRAGMA table_info(service_requests)")->fetchAll(PDO::FETCH_ASSOC), 'name');
lifecycleExpectSame(true, in_array('assigned_vehicle_id', $serviceRequestColumns, true),
    'service request preparation must create the full current schema before migrations run');
lifecycleExpectSame(true, in_array('attribution_gclid', $serviceRequestColumns, true),
    'service request preparation must include attribution columns');
hsEnsureSchema($pdo);

$formattedServiceRequest = hsServiceRequestForResponse([
    'id' => 1,
    'location' => "حي الياسمين، الرياض\nإحداثيات GPS: 24.823456,46.623456",
]);
lifecycleExpectSame('حي الياسمين، الرياض', $formattedServiceRequest['location'],
    'contract workflow responses must not expose GPS markers in the displayed address');
lifecycleExpectSame('24.823456,46.623456', $formattedServiceRequest['locationCoordinates'],
    'contract workflow responses must preserve coordinates separately for map use');

$insertRecord = static function (string $kind, string $status, string $reference, array $payload) use ($pdo): int {
    $now = date('c');
    $stmt = $pdo->prepare("INSERT INTO container_system_records
        (kind, status, reference, payload, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)");
    $stmt->execute([
        $kind, $status, $reference,
        json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE),
        $now, $now,
    ]);
    return (int)$pdo->lastInsertId();
};

$identifierCustomerId = $insertRecord('customer', 'active', 'TEST-ONLY-CUSTOMER-ID-1', [
    'name' => 'TEST ONLY — no real customer',
]);
lifecycleExpectSame(null, hsContractBusinessIdentifierError($pdo, [
    'classification' => 'debris',
    'customerRecordId' => $identifierCustomerId,
]), 'debris contracts must not require customer commercial identifiers');
lifecycleExpectSame('السجل التجاري للعميل مطلوب لعقود النفايات', hsContractBusinessIdentifierError($pdo, [
    'classification' => 'waste',
    'customerRecordId' => $identifierCustomerId,
]), 'waste contracts must require the customer commercial registration');
$pdo->prepare("UPDATE container_system_records SET payload = ? WHERE id = ?")
    ->execute([json_encode(['commercialRegistration' => 'TEST-ONLY-CR'], JSON_UNESCAPED_UNICODE), $identifierCustomerId]);
lifecycleExpectSame('الرقم الضريبي للعميل مطلوب لعقود النفايات', hsContractBusinessIdentifierError($pdo, [
    'classification' => 'waste',
    'customerRecordId' => $identifierCustomerId,
]), 'waste contracts must require the customer tax number');
$pdo->prepare("UPDATE container_system_records SET payload = ? WHERE id = ?")
    ->execute([json_encode([
        'commercialRegistration' => 'TEST-ONLY-CR',
        'taxNumber' => 'TEST-ONLY-TAX',
    ], JSON_UNESCAPED_UNICODE), $identifierCustomerId]);
lifecycleExpectSame(null, hsContractBusinessIdentifierError($pdo, [
    'classification' => 'waste',
    'customerRecordId' => $identifierCustomerId,
]), 'waste contracts must accept both customer identifiers when present');

$containerId = $insertRecord('container_asset', 'available', 'TEST-ONLY-ASSET-1', [
    'assetCode' => 'TEST-ONLY-ASSET-1',
    'status' => 'available',
    'location' => 'TEST ONLY — warehouse',
]);
$assetRow = $pdo->query("SELECT * FROM container_system_records WHERE id = {$containerId}")->fetch(PDO::FETCH_ASSOC);
$assetStatusIssue = hsProtectedRecordMutationIssue($assetRow, ['status' => 'rented']);
lifecycleExpectSame(409, (int)($assetStatusIssue['status'] ?? 0),
    'asset status must not be changed without an operational movement');
$contractId = $insertRecord('contract', 'active', 'TEST-ONLY-CONTRACT-1', [
    'contractNumber' => 'TEST-ONLY-CONTRACT-1',
    'containerRecordId' => $containerId,
    'containerCode' => 'TEST-ONLY-ASSET-1',
    'startDate' => '2026-10-01',
    'endDate' => '2026-10-31',
    'total' => 100,
    'location' => 'TEST ONLY — customer site',
]);
lifecycleExpectSame(true, hsContractHasOverlappingDates($pdo, [
    'containerCode' => 'TEST-ONLY-ASSET-1',
    'startDate' => '2026-10-15',
    'endDate' => '2026-11-15',
]), 'overlapping date ranges must be rejected for the same container');
lifecycleExpectSame(false, hsContractHasOverlappingDates($pdo, [
    'containerCode' => 'TEST-ONLY-ASSET-1',
    'startDate' => '2026-10-15',
    'endDate' => '2026-11-15',
], $contractId), 'editing a contract must ignore its own record');
lifecycleExpectSame(false, hsHasActiveContainerAssignment($pdo, $containerId),
    'an asset without an active assignment must remain assignable');
$contractRow = $pdo->query("SELECT * FROM container_system_records WHERE id = {$contractId}")->fetch(PDO::FETCH_ASSOC);
$contractStatusIssue = hsProtectedRecordMutationIssue($contractRow, ['status' => 'returned']);
lifecycleExpectSame(409, (int)($contractStatusIssue['status'] ?? 0),
    'contract status must use the lifecycle action that records its movement');
$contractPayloadStatusIssue = hsProtectedRecordMutationIssue($contractRow, ['payload' => ['status' => 'returned']]);
lifecycleExpectSame(409, (int)($contractPayloadStatusIssue['status'] ?? 0),
    'contract payload status must not bypass the lifecycle action');
$pdo->prepare("INSERT INTO service_requests
    (client_name, phone, service_type, location, created_at, updated_at, status, container_record_id, contract_record_id, driver_status)
    VALUES ('TEST ONLY — lifecycle fixture', 'TEST ONLY', 'تسليم حاوية', 'TEST ONLY', ?, ?, 'pending', ?, ?, 'assigned')")
    ->execute([date('c'), date('c'), $containerId, $contractId]);
$requestId = (int)$pdo->lastInsertId();
$requestRow = $pdo->query("SELECT * FROM service_requests WHERE id = {$requestId}")->fetch(PDO::FETCH_ASSOC);
$cancelIssue = hsServiceRequestMutationIssue($pdo, $requestRow, ['status' => 'cancelled']);
lifecycleExpectSame(409, (int)($cancelIssue['status'] ?? 0),
    'a contract-linked request must not be cancelled through the generic status route');
$driverStatusIssue = hsServiceRequestMutationIssue($pdo, $requestRow, ['driverStatus' => 'completed']);
lifecycleExpectSame(422, (int)($driverStatusIssue['status'] ?? 0),
    'driver status must not be changed through the generic request route');
$lineId = $insertRecord('contract_line', 'active', 'TEST-ONLY-LINE-1', [
    'contractRecordId' => $contractId,
    'status' => 'active',
]);
$assignmentId = $insertRecord('container_assignment', 'active', 'TEST-ONLY-ASSIGNMENT-1', [
    'contractRecordId' => $contractId,
    'containerRecordId' => $containerId,
    'assignmentStatus' => 'active',
]);
lifecycleExpectSame(true, hsHasActiveContainerAssignment($pdo, $containerId),
    'an active assignment must block another container contract');
$manager = ['id' => 1, 'role' => 'manager'];

lifecycleExpectFailure(
    static fn() => hsUpdateContainerContractLifecycle($pdo, $contractId, 'deliver', '', 1, $manager),
    422,
    'an open delivery request must prevent contract delivery',
);
lifecycleExpectSame('active', (string)$pdo->query("SELECT status FROM container_system_records WHERE id = {$contractId}")->fetchColumn(),
    'a blocked delivery must leave the contract unchanged');
lifecycleExpectSame(0, (int)$pdo->query("SELECT COUNT(*) FROM container_system_records WHERE kind = 'container_movement'")->fetchColumn(),
    'a blocked delivery must not create a movement');

$workOrderPayload = [
    'legacyRequestId' => $requestId,
    'contractRecordId' => $contractId,
    'containerRecordId' => $containerId,
    'assignedDriverId' => 1,
    'driverStatus' => 'assigned',
    'status' => 'assigned',
];
$workOrderId = $insertRecord('work_order', 'assigned', 'TEST-ONLY-WORK-ORDER-1', $workOrderPayload);
$completionIssue = hsServiceRequestMutationIssue($pdo, $requestRow, ['status' => 'completed']);
lifecycleExpectSame(409, (int)($completionIssue['status'] ?? 0),
    'generic request completion must not bypass an open work order');
$pdo->prepare("UPDATE service_requests SET status = 'completed', driver_status = 'completed' WHERE id = ?")->execute([$requestId]);
$pdo->prepare("UPDATE container_system_records SET status = 'completed', payload = ? WHERE id = ?")->execute([
    json_encode(array_merge($workOrderPayload, [
        'status' => 'completed',
        'driverStatus' => 'completed',
        'driverProofPhotoUrl' => '/uploads/TEST-ONLY-lifecycle-proof.webp',
        'driverSignatureData' => 'TEST ONLY — lifecycle signature',
        'driverReceiverName' => 'TEST ONLY — lifecycle receiver',
    ]), JSON_UNESCAPED_UNICODE),
    $workOrderId,
]);
$delivery = hsUpdateContainerContractLifecycle($pdo, $contractId, 'deliver', 'TEST ONLY — delivery location', 1, $manager);
lifecycleExpectSame('delivered', (string)$delivery['contract']['status'], 'delivery must advance the contract');
lifecycleExpectSame('rented', (string)$pdo->query("SELECT status FROM container_system_records WHERE id = {$containerId}")->fetchColumn(),
    'delivery must mark the asset as rented');
lifecycleExpectSame('deliver', (string)hsPayload($delivery['movement']['payload'])['movementType'], 'delivery must write its movement');
$contractRow = $pdo->query("SELECT * FROM container_system_records WHERE id = {$contractId}")->fetch(PDO::FETCH_ASSOC);
$changedContractPayload = hsPayload($contractRow['payload']);
$changedContractPayload['total'] = 125;
lifecycleExpectSame(true, hsContractPatchRequiresAmendment($pdo, $contractRow, $changedContractPayload),
    'contract terms must not change after an operational movement');

$return = hsUpdateContainerContractLifecycle($pdo, $contractId, 'return', '', 1, $manager);
lifecycleExpectSame('returned', (string)$return['contract']['status'], 'return must advance the contract');
lifecycleExpectSame('available', (string)$pdo->query("SELECT status FROM container_system_records WHERE id = {$containerId}")->fetchColumn(),
    'return must make the asset available');

lifecycleExpectFailure(
    static fn() => hsUpdateContainerContractLifecycle($pdo, $contractId, 'close', '', 1, $manager),
    422,
    'a contract with an outstanding balance must not close',
);
$paymentId = $insertRecord('payment', 'posted', 'TEST-ONLY-PAYMENT-1', [
    'contractRecordId' => $contractId,
    'contractNumber' => 'TEST-ONLY-CONTRACT-1',
    'amount' => 100,
    'date' => date('Y-m-d'),
]);
$invoiceId = $insertRecord('invoice', 'draft', 'TEST-ONLY-INVOICE-1', [
    'contractRecordId' => $contractId,
    'contractNumber' => 'TEST-ONLY-CONTRACT-1',
    'total' => 100,
    'remaining' => 100,
]);
lifecycleExpectFailure(
    static fn() => hsUpdateContainerContractLifecycle($pdo, $contractId, 'close', '', 1, $manager),
    422,
    'an unposted invoice must prevent contract closure',
);
lifecycleExpectSame('returned', (string)$pdo->query("SELECT status FROM container_system_records WHERE id = {$contractId}")->fetchColumn(),
    'a failed close must leave the returned contract unchanged');

$pdo->prepare("UPDATE container_system_records SET status = 'paid', payload = ? WHERE id = ?")->execute([
    json_encode([
        'contractRecordId' => $contractId,
        'contractNumber' => 'TEST-ONLY-CONTRACT-1',
        'total' => 100,
        'paid' => 100,
        'remaining' => 0,
    ], JSON_UNESCAPED_UNICODE),
    $invoiceId,
]);
lifecycleExpectFailure(
    static fn() => hsUpdateContainerContractLifecycle($pdo, $contractId, 'close', '', 1, $manager),
    422,
    'a paid invoice without a posted financial-core transaction must prevent closure',
);
$pdo->prepare("INSERT INTO financial_transactions
    (transaction_number, transaction_type, source_kind, source_id, reference, transaction_date, amount, currency, status)
    VALUES ('TEST-ONLY-INVOICE-POSTING-1', 'invoice', 'invoice', ?, 'TEST ONLY', ?, 100, 'SAR', 'posted')")
    ->execute([$invoiceId, date('Y-m-d')]);

$closed = hsUpdateContainerContractLifecycle($pdo, $contractId, 'close', '', 1, $manager);
lifecycleExpectSame('closed', (string)$closed['contract']['status'], 'a fully settled returned contract may close');
lifecycleExpectSame('closed', (string)$pdo->query("SELECT status FROM container_system_records WHERE id = {$lineId}")->fetchColumn(),
    'closing the contract must close its linked contract lines');
lifecycleExpectSame('closed', (string)$pdo->query("SELECT status FROM container_system_records WHERE id = {$assignmentId}")->fetchColumn(),
    'closing the contract must close its linked assignment');
lifecycleExpectSame('available', (string)$pdo->query("SELECT status FROM container_system_records WHERE id = {$containerId}")->fetchColumn(),
    'closing the contract must release its asset');
lifecycleExpectSame(2, (int)$pdo->query("SELECT COUNT(*) FROM container_system_records WHERE kind = 'container_movement'")->fetchColumn(),
    'delivery and return must each create one movement');

$approvalId = $insertRecord('contract', 'pending_approval', 'TEST-ONLY-CONTRACT-APPROVE', [
    'contractNumber' => 'TEST-ONLY-CONTRACT-APPROVE',
]);
$approved = hsUpdateContainerContractLifecycle($pdo, $approvalId, 'approve', '', 1, $manager);
lifecycleExpectSame('approved', (string)$approved['contract']['status'], 'a manager may approve an eligible contract');

$rejectionId = $insertRecord('contract', 'draft', 'TEST-ONLY-CONTRACT-REJECT', [
    'contractNumber' => 'TEST-ONLY-CONTRACT-REJECT',
]);
$rejected = hsUpdateContainerContractLifecycle($pdo, $rejectionId, 'reject', '', 1, $manager);
lifecycleExpectSame('rejected', (string)$rejected['contract']['status'], 'a manager may reject an eligible contract');

$conflictingRequestId = 0;
$pdo->prepare("INSERT INTO service_requests
    (client_name, phone, service_type, location, created_at, updated_at, status, scheduled_at,
     duration, contract_record_id, container_record_id, assigned_driver_id, driver_status)
    VALUES ('TEST ONLY — conflicting dispatch', 'TEST ONLY', 'تسليم حاوية', 'TEST ONLY',
     ?, ?, 'in_progress', '2026-10-30T10:00:00.000Z', '1 hour', ?, ?, 7, 'arrived')")
    ->execute([date('c'), date('c'), $contractId, $containerId]);
$conflictingRequestId = (int)$pdo->lastInsertId();
$conflictingWorkOrderId = $insertRecord('work_order', 'completed', 'TEST-ONLY-CONFLICTING-WORK-ORDER', [
    'operationType' => 'DELIVER_CONTAINER',
    'serviceType' => 'تسليم حاوية',
    'contractRecordId' => $contractId,
    'containerRecordId' => $containerId,
    'scheduledAt' => '2026-10-30T10:00:00.000Z',
    'assignedDriverId' => 7,
    'driverStatus' => 'completed',
    'status' => 'completed',
]);
$targetWorkOrderId = $insertRecord('work_order', 'assigned', 'TEST-ONLY-EXPLICIT-APPOINTMENT-LINK', [
    'operationType' => 'DELIVER_CONTAINER',
    'serviceType' => 'تسليم حاوية',
    'contractRecordId' => $contractId,
    'containerRecordId' => $containerId,
    'scheduledAt' => '2026-10-31T10:00:00.000Z',
    'driverStatus' => 'assigned',
    'status' => 'assigned',
]);
$appointmentId = $insertRecord('appointment', 'scheduled', 'TEST-ONLY-LEGACY-APPOINTMENT', [
    'workOrderRecordId' => $targetWorkOrderId,
    'serviceType' => 'تسليم حاوية',
    'appointmentType' => 'scheduled',
    'contractRecordId' => $contractId,
    'containerRecordId' => $containerId,
    'scheduledAt' => '2026-10-31T10:00:00.000Z',
]);
$unknownAppointmentId = $insertRecord('appointment', 'scheduled', 'TEST-ONLY-UNKNOWN-APPOINTMENT', [
    'appointmentType' => 'scheduled',
    'contractRecordId' => $contractId,
    'containerRecordId' => $containerId,
    'scheduledAt' => '2026-11-01T10:00:00.000Z',
]);
$pdo->prepare("INSERT INTO service_requests
    (client_name, phone, service_type, location, created_at, updated_at, status, driver_status)
    VALUES ('TEST ONLY — duplicate links', 'TEST ONLY', 'TEST ONLY — generic request', 'TEST ONLY', ?, ?, 'pending', 'unassigned')")
    ->execute([date('c'), date('c')]);
$duplicateLinkRequestId = (int)$pdo->lastInsertId();
$insertRecord('work_order', 'new', 'TEST-ONLY-DUPLICATE-LINK-A', [
    'legacyRequestId' => $duplicateLinkRequestId,
    'operationKey' => 'TEST-ONLY-DUPLICATE-LINK-A',
]);
$insertRecord('work_order', 'new', 'TEST-ONLY-DUPLICATE-LINK-B', [
    'legacyRequestId' => $duplicateLinkRequestId,
    'operationKey' => 'TEST-ONLY-DUPLICATE-LINK-B',
]);

$movementCountBeforeMigration = (int)$pdo->query(
    "SELECT COUNT(*) FROM container_system_records WHERE kind='container_movement'"
)->fetchColumn();
hsEnsureCanonicalDispatchTasks($pdo);

$canonicalRequestStmt = $pdo->prepare("SELECT id,payload FROM container_system_records
    WHERE kind='work_order' AND CAST(json_extract(payload, '$.legacyRequestId') AS INTEGER)=:request_id LIMIT 1");
$canonicalRequestStmt->execute([':request_id' => $conflictingRequestId]);
$canonicalRequest = $canonicalRequestStmt->fetch(PDO::FETCH_ASSOC);
lifecycleExpectSame(true, is_array($canonicalRequest), 'a legacy request must be promoted into a work order');
$canonicalRequestPayload = json_decode((string)$canonicalRequest['payload'], true);
lifecycleExpectSame(true, (bool)($canonicalRequestPayload['reconciliationRequired'] ?? false),
    'a request with conflicting driver state must require reconciliation');
lifecycleExpectSame('arrived', (string)($canonicalRequestPayload['driverStatus'] ?? ''),
    'the promoted request must preserve its own driver state');
lifecycleExpectSame('completed', (string)hsPayload(
    $pdo->query("SELECT payload FROM container_system_records WHERE id = {$conflictingWorkOrderId}")->fetchColumn()
)['driverStatus'], 'the conflicting existing work order must remain unchanged');

$linkedAppointmentPayload = hsPayload(
    $pdo->query("SELECT payload FROM container_system_records WHERE id = {$targetWorkOrderId}")->fetchColumn()
);
lifecycleExpectSame($appointmentId, (int)($linkedAppointmentPayload['appointmentRecordId'] ?? 0),
    'an explicit appointment-to-work-order reference must be preserved');
$unknownAppointmentOrder = null;
$duplicateLinkOrders = [];
foreach ($pdo->query("SELECT id,payload FROM container_system_records WHERE kind='work_order'")->fetchAll(PDO::FETCH_ASSOC) as $workOrderRow) {
    $workOrderPayload = hsPayload($workOrderRow['payload']);
    if ((int)($workOrderPayload['legacyAppointmentId'] ?? 0) === $unknownAppointmentId) {
        $unknownAppointmentOrder = $workOrderPayload;
    }
    if ((int)($workOrderPayload['legacyRequestId'] ?? 0) === $duplicateLinkRequestId) {
        $duplicateLinkOrders[] = $workOrderPayload;
    }
}
lifecycleExpectSame(true, (bool)($unknownAppointmentOrder['reconciliationRequired'] ?? false),
    'an appointment without a recognized operation must be held for review');
lifecycleExpectSame(2, count($duplicateLinkOrders), 'pre-existing duplicate links must be retained');
lifecycleExpectSame(true, !empty($duplicateLinkOrders[0]['reconciliationRequired'])
    && !empty($duplicateLinkOrders[1]['reconciliationRequired']),
    'every duplicate canonical link must be flagged for reconciliation');
lifecycleExpectSame($movementCountBeforeMigration, (int)$pdo->query(
    "SELECT COUNT(*) FROM container_system_records WHERE kind='container_movement'"
)->fetchColumn(), 'canonicalization must not create container movements');

$workOrderCountAfterMigration = (int)$pdo->query(
    "SELECT COUNT(*) FROM container_system_records WHERE kind='work_order'"
)->fetchColumn();
$auditCountAfterMigration = (int)$pdo->query("SELECT COUNT(*) FROM container_system_audit")->fetchColumn();
hsEnsureCanonicalDispatchTasks($pdo);
lifecycleExpectSame($workOrderCountAfterMigration, (int)$pdo->query(
    "SELECT COUNT(*) FROM container_system_records WHERE kind='work_order'"
)->fetchColumn(), 'canonicalization must be idempotent');
lifecycleExpectSame($auditCountAfterMigration, (int)$pdo->query(
    "SELECT COUNT(*) FROM container_system_audit"
)->fetchColumn(), 'an idempotent rerun must not duplicate audit rows');

echo "PHP contract lifecycle and dispatch canonicalization assertions passed using an isolated in-memory database\n";
