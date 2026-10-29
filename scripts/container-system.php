<?php
declare(strict_types=1);

require_once __DIR__ . '/dispatch-canonicalization.php';

/**
 * Hostinger container-system API.
 *
 * This file is included by api-index.php and intentionally uses PHP 7.4+
 * PDO and SQLite. It mirrors the development API's generic record contract so
 * the existing admin UI works on shared hosting without Node.js.
 */

function hsJson($value, int $status = 200): void {
    http_response_code($status);
    echo json_encode($value, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function hsPayload($value): array {
    if (!$value) return [];
    $decoded = json_decode($value, true);
    return is_array($decoded) ? $decoded : [];
}

function hsContractPatchRequiresAmendment(PDO $pdo, array $contract, array $nextPayload): bool {
    $before = hsPayload($contract['payload'] ?? null);
    $termFields = [
        'amount', 'total', 'subtotal', 'taxAmount', 'taxRate', 'taxEnabled', 'currency',
        'contractNumber', 'customerRecordId', 'customerName', 'siteRecordId', 'location', 'address',
        'containerRecordId', 'assignedContainerRecordId', 'containerCode', 'startDate', 'endDate',
        'duration', 'billingFrequency', 'serviceType', 'terms', 'contractTerms',
    ];
    $termsChanged = false;
    foreach ($termFields as $field) {
        if (json_encode($before[$field] ?? null) !== json_encode($nextPayload[$field] ?? null)) {
            $termsChanged = true;
            break;
        }
    }
    if (!$termsChanged) return false;

    $contractId = (int)$contract['id'];
    $contractNumber = trim((string)($before['contractNumber'] ?? $contract['reference'] ?? ''));
    $referencesContract = static function(array $payload) use ($contractId, $contractNumber): bool {
        if ((int)($payload['contractRecordId'] ?? $payload['contractId'] ?? 0) === $contractId) return true;
        if ($contractNumber !== '' && trim((string)($payload['contractNumber'] ?? '')) === $contractNumber) return true;
        foreach (($payload['allocations'] ?? []) as $allocation) {
            if (is_array($allocation) && (int)($allocation['contractId'] ?? 0) === $contractId) return true;
        }
        return false;
    };
    $lifecycleAdvanced = in_array((string)$contract['status'], ['delivered', 'returned', 'closed'], true);
    $financialPosted = false;
    foreach ($pdo->query("SELECT kind,status,payload FROM container_system_records")->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $payload = hsPayload($row['payload'] ?? null);
        if (!$referencesContract($payload)) continue;
        if (($row['kind'] ?? '') === 'container_movement') $lifecycleAdvanced = true;
        if (($row['kind'] ?? '') === 'work_order'
            && ((int)($payload['assignedDriverId'] ?? 0) > 0
                || (int)($payload['assignedVehicleId'] ?? 0) > 0
                || in_array((string)($payload['driverStatus'] ?? ''), ['accepted', 'started', 'in_progress', 'en_route', 'arrived', 'completed'], true))) {
            $lifecycleAdvanced = true;
        }
        if (in_array((string)($row['kind'] ?? ''), ['payment', 'receipt', 'payment_return', 'invoice_return'], true)
            && ($row['status'] ?? '') === 'posted') {
            $financialPosted = true;
        }
        if (($row['kind'] ?? '') === 'invoice'
            && in_array((string)($row['status'] ?? ''), ['posted', 'partially_paid', 'paid', 'settled'], true)) {
            $financialPosted = true;
        }
    }
    return $lifecycleAdvanced || $financialPosted;
}

function hsProtectedRecordMutationIssue(array $current, array $input): ?array {
    $kind = (string)($current['kind'] ?? '');
    if (in_array($kind, ['container', 'container_asset'], true)) {
        $currentStatus = hsCanonicalAssetStatus((string)($current['status'] ?? ''), (string)($current['status'] ?? ''));
        $rowStatus = array_key_exists('status', $input)
            ? hsCanonicalAssetStatus((string)$input['status'], $currentStatus)
            : $currentStatus;
        $payload = is_array($input['payload'] ?? null) ? $input['payload'] : [];
        $payloadStatus = array_key_exists('status', $payload)
            ? hsCanonicalAssetStatus((string)$payload['status'], $currentStatus)
            : $currentStatus;
        if ($rowStatus !== $currentStatus || $payloadStatus !== $currentStatus) {
            return ['status' => 409, 'error' => 'حالة الأصل لا تتغير مباشرة؛ سجّل حركة أو تخصيصًا موثقًا'];
        }
    }
    if ($kind === 'contract') {
        if (array_key_exists('status', $input) && (string)$input['status'] !== (string)($current['status'] ?? '')) {
            return ['status' => 409, 'error' => 'لا تغيّر حالة العقد مباشرة؛ استخدم إجراء دورة العقد المسجل بالحركة'];
        }
        $currentPayload = hsPayload($current['payload'] ?? null);
        $nextPayload = is_array($input['payload'] ?? null) ? $input['payload'] : [];
        if (array_key_exists('status', $nextPayload)
            && (string)$nextPayload['status'] !== (string)($currentPayload['status'] ?? $current['status'] ?? '')) {
            return ['status' => 409, 'error' => 'لا تغيّر حالة العقد داخل بياناته مباشرة؛ استخدم إجراء دورة العقد المسجل بالحركة'];
        }
    }
    return null;
}

function hsServiceRequestMutationIssue(PDO $pdo, array $request, array $input): ?array {
    if (array_key_exists('driverStatus', $input)) {
        return ['status' => 422, 'error' => 'حالة السائق لا تُعدّل من سجل الطلب؛ استخدم انتقال أمر العمل'];
    }
    if (!array_key_exists('status', $input)) return null;

    $currentStatus = (string)($request['status'] ?? 'pending');
    $nextStatus = (string)$input['status'];
    $transitions = [
        'pending' => ['pending', 'in_progress', 'cancelled', 'rejected'],
        'in_progress' => ['in_progress', 'completed', 'cancelled', 'rejected'],
        'completed' => ['completed'],
        'cancelled' => ['cancelled'],
        'rejected' => ['rejected'],
    ];
    if (!array_key_exists($nextStatus, $transitions)) {
        return ['status' => 422, 'error' => 'حالة الطلب غير مدعومة'];
    }
    if (!in_array($nextStatus, $transitions[$currentStatus] ?? [], true)) {
        return ['status' => 409, 'error' => 'لا يمكن نقل الطلب من ' . $currentStatus . ' إلى ' . $nextStatus];
    }

    $hasContainerCommitment = (int)($request['contract_record_id'] ?? 0) > 0
        || (int)($request['container_record_id'] ?? 0) > 0;
    $hasDispatchCommitment = (int)($request['assigned_driver_id'] ?? 0) > 0
        || (int)($request['assigned_vehicle_id'] ?? 0) > 0
        || !in_array((string)($request['driver_status'] ?? 'unassigned'), ['unassigned', 'cancelled', 'rejected'], true);
    $linked = $pdo->prepare("SELECT payload FROM container_system_records WHERE kind='work_order' AND status<>'archived' AND json_extract(payload, '$.legacyRequestId') = :id");
    $linked->execute([':id' => (int)$request['id']]);
    $linkedOrders = $linked->fetchAll(PDO::FETCH_ASSOC);
    if (count($linkedOrders) > 1) {
        return ['status' => 409, 'error' => 'طلب الخدمة مرتبط بأكثر من مهمة؛ يلزم حسم التعارض قبل تعديل الحالة'];
    }
    foreach ($linkedOrders as $row) {
        $payload = hsPayload($row['payload'] ?? null);
        if (!empty($payload['reconciliationRequired'])) {
            return ['status' => 409, 'error' => 'طلب الخدمة مرتبط بمهمة تحتاج إلى مراجعة الإدارة قبل تعديل الحالة'];
        }
        if ($nextStatus === 'completed' && (string)($payload['driverStatus'] ?? 'unassigned') !== 'completed') {
            return ['status' => 409, 'error' => 'لا يمكن إكمال الطلب إداريًا قبل إكمال أمر العمل وإثباته من مسار السائق'];
        }
        $hasContainerCommitment = $hasContainerCommitment
            || (int)($payload['contractRecordId'] ?? 0) > 0
            || (int)($payload['containerRecordId'] ?? 0) > 0;
        $hasDispatchCommitment = $hasDispatchCommitment
            || (int)($payload['assignedDriverId'] ?? 0) > 0
            || (int)($payload['assignedVehicleId'] ?? 0) > 0
            || !in_array((string)($payload['driverStatus'] ?? 'unassigned'), ['unassigned', 'cancelled', 'rejected'], true);
    }
    if (!in_array($nextStatus, ['cancelled', 'rejected'], true)) return null;
    if ($hasContainerCommitment || $hasDispatchCommitment) {
        return ['status' => 409, 'error' => 'لا يمكن إلغاء طلب مرتبط بعقد أو أصل أو إسناد؛ أوقف المهمة وسوِّ الالتزامات عبر مسار الإلغاء الموثق'];
    }
    return null;
}

function hsSplitLocationText($value, $explicitCoordinates = null): array {
    $raw = trim((string)($value ?? ''));
    $explicit = trim((string)($explicitCoordinates ?? ''));
    $coordinatePattern = '/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/';
    $markerPattern = '/(?:إحداثيات\s*GPS|GPS)\s*[:：]\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/iu';
    $lat = null;
    $lng = null;
    $match = [];
    if (preg_match($coordinatePattern, $explicit, $match)) {
        $lat = (float)$match[1];
        $lng = (float)$match[2];
    } elseif (preg_match($markerPattern, $raw, $match)) {
        $lat = (float)$match[1];
        $lng = (float)$match[2];
    } elseif (preg_match($coordinatePattern, $raw, $match)) {
        $lat = (float)$match[1];
        $lng = (float)$match[2];
    }
    $coordinates = $lat !== null && $lng !== null && abs($lat) <= 90 && abs($lng) <= 180
        ? rtrim(rtrim(number_format($lat, 8, '.', ''), '0'), '.') . ',' . rtrim(rtrim(number_format($lng, 8, '.', ''), '0'), '.')
        : '';
    $address = preg_match($markerPattern, $raw)
        ? trim((string)preg_replace('/\s*\(?\s*(?:إحداثيات\s*GPS|GPS)\s*[:：]\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\)?/iu', '', $raw), " \t\n\r\0\x0B,،()")
        : (preg_match($coordinatePattern, $raw) ? '' : $raw);
    return ['address' => $address, 'coordinates' => $coordinates];
}

function hsEncodeLocationText($value, $explicitCoordinates = null): string {
    $raw = trim((string)($value ?? ''));
    $parts = hsSplitLocationText($raw, $explicitCoordinates);
    if ($parts['coordinates'] === '') return $parts['address'] !== '' ? $parts['address'] : $raw;
    return $parts['address'] . "\nإحداثيات GPS: " . $parts['coordinates'];
}

function hsCleanLocationPayload(array $payload): array {
    $fields = [
        'location' => 'locationCoordinates',
        'address' => 'addressCoordinates',
        'serviceAddress' => 'serviceAddressCoordinates',
        'customerAddress' => 'customerAddressCoordinates',
        'currentLocation' => 'currentLocationCoordinates',
        'siteAddress' => 'siteAddressCoordinates',
    ];
    foreach ($fields as $field => $coordinateField) {
        if (!isset($payload[$field]) || !is_string($payload[$field])) continue;
        $explicit = $payload[$coordinateField] ?? ($field === 'location' ? ($payload['locationCoordinates'] ?? null) : null);
        $parts = hsSplitLocationText($payload[$field], $explicit);
        if ($parts['coordinates'] !== '' && empty($payload[$coordinateField])) $payload[$coordinateField] = $parts['coordinates'];
        $payload[$field] = $parts['address'] !== '' ? $parts['address'] : ($parts['coordinates'] !== '' ? 'الموقع المحدد' : trim($payload[$field]));
    }
    return $payload;
}

function hsRefreshPrivateUploadUrl($value): ?string {
    $raw = trim((string)($value ?? ''));
    if ($raw === '') return null;
    $path = parse_url($raw, PHP_URL_PATH);
    if (!is_string($path) || !preg_match('#^/api/private-uploads/([^/?#]+)$#', $path, $match)) return $raw;
    $filename = rawurldecode($match[1]);
    $secret = trim((string)getenv('SESSION_SECRET'));
    if ($secret === '' || !preg_match('/^[A-Za-z0-9._-]+$/', $filename)) return $raw;
    $expires = time() + 30 * 60;
    $signature = rtrim(strtr(base64_encode(hash_hmac('sha256', $filename . '.' . $expires, $secret, true)), '+/', '-_'), '=');
    return '/api/private-uploads/' . rawurlencode($filename) . '?expires=' . $expires . '&signature=' . rawurlencode($signature);
}

function hsRecord(array $row): array {
    $row['id'] = (int)$row['id'];
    $row['createdBy'] = isset($row['created_by']) ? (int)$row['created_by'] : null;
    $row['createdAt'] = $row['created_at'] ?? null;
    $row['updatedAt'] = $row['updated_at'] ?? null;
    $row['payload'] = hsCleanLocationPayload(hsPayload($row['payload'] ?? null));
    foreach (['driverProofPhotoUrl', 'proofPhotoUrl'] as $photoField) {
        if (!empty($row['payload'][$photoField])) $row['payload'][$photoField] = hsRefreshPrivateUploadUrl($row['payload'][$photoField]);
    }
    unset($row['created_by'], $row['created_at'], $row['updated_at']);
    return $row;
}

function hsPostedCollections(array $rows): array {
    $posted = array_values(array_filter($rows, static fn(array $row): bool =>
        $row['status'] === 'posted' && in_array($row['kind'], ['payment', 'receipt'], true)
    ));
    $payments = array_values(array_filter($posted, static fn(array $row): bool => $row['kind'] === 'payment'));
    $keys = [];
    foreach ($payments as $payment) {
        $payload = $payment['payload'];
        $keys[] = implode('|', [
            (string)($payload['customerRecordId'] ?? ''),
            (string)($payload['contractRecordId'] ?? $payload['contractNumber'] ?? ''),
            (string)($payload['invoiceRecordId'] ?? $payload['invoiceNumber'] ?? ''),
            (string)($payload['amount'] ?? ''),
            (string)($payload['date'] ?? ''),
        ]);
    }
    foreach ($posted as $row) {
        if ($row['kind'] !== 'receipt') continue;
        $payload = $row['payload'];
        $key = implode('|', [
            (string)($payload['customerRecordId'] ?? ''),
            (string)($payload['contractRecordId'] ?? $payload['contractNumber'] ?? ''),
            (string)($payload['invoiceRecordId'] ?? $payload['invoiceNumber'] ?? ''),
            (string)($payload['amount'] ?? ''),
            (string)($payload['date'] ?? ''),
        ]);
        if (!isset($payload['sourcePaymentId']) && !in_array($key, $keys, true)) $payments[] = $row;
    }
    return $payments;
}

function hsFinancialTables(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS financial_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        category TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )");
    $pdo->exec("CREATE TABLE IF NOT EXISTS financial_periods (
        id INTEGER PRIMARY KEY AUTOINCREMENT, period_key TEXT NOT NULL UNIQUE, starts_on TEXT NOT NULL,
        ends_on TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', closed_by INTEGER, closed_at TEXT
    )");
    $pdo->exec("CREATE TABLE IF NOT EXISTS financial_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_number TEXT NOT NULL, transaction_type TEXT NOT NULL,
        source_kind TEXT NOT NULL, source_id INTEGER NOT NULL, reference TEXT NOT NULL DEFAULT '',
        transaction_date TEXT NOT NULL, amount REAL NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'SAR',
        status TEXT NOT NULL DEFAULT 'posted', operation_key TEXT UNIQUE, created_by INTEGER, posted_at TEXT,
        cancellation_reason TEXT, UNIQUE(source_kind, source_id)
    )");
    $pdo->exec("CREATE TABLE IF NOT EXISTS financial_journal_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_id INTEGER NOT NULL UNIQUE,
        entry_number TEXT NOT NULL, total_debit REAL NOT NULL DEFAULT 0,
        total_credit REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'posted'
    )");
    $pdo->exec("CREATE TABLE IF NOT EXISTS financial_journal_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT, journal_entry_id INTEGER NOT NULL, account_code TEXT NOT NULL,
        debit REAL NOT NULL DEFAULT 0, credit REAL NOT NULL DEFAULT 0, description TEXT NOT NULL DEFAULT ''
    )");
    $pdo->exec("CREATE TABLE IF NOT EXISTS financial_allocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_id INTEGER NOT NULL,
        contract_id INTEGER, invoice_id INTEGER, amount REAL NOT NULL
    )");
    $pdo->exec("CREATE TABLE IF NOT EXISTS bank_reconciliations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, deposit_record_id INTEGER NOT NULL,
        bank_account_code TEXT NOT NULL DEFAULT 'BANK-001', deposit_reference TEXT NOT NULL DEFAULT '',
        deposit_date TEXT NOT NULL, amount REAL NOT NULL, linked_transaction_id INTEGER,
        bank_fee REAL NOT NULL DEFAULT 0, difference REAL NOT NULL DEFAULT 0,
        difference_reason TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'unmatched',
        approved_by INTEGER, approved_at TEXT, reviewed_by INTEGER, reviewed_at TEXT,
        rejection_reason TEXT NOT NULL DEFAULT '', audit_trail TEXT NOT NULL DEFAULT '[]'
    )");
    $accounts = [
        ['CASH-001','الخزينة الرئيسية','cash'], ['BANK-001','الحساب البنكي الرئيسي','bank'],
        ['AR-001','ذمم العملاء','receivable'], ['AP-001','ذمم الموردين','payable'],
        ['REV-001','إيرادات الخدمات','revenue'], ['REV-OTHER','إيرادات أخرى','other_revenue'],
        ['EXP-001','المصروفات العامة','expense'], ['EXP-MAINT','مصروفات الصيانة','maintenance'],
        ['INV-001','المخزون','inventory'], ['COGS-001','تكلفة المبيعات','cogs'],
        ['COMM-001','العمولات','commission'], ['BANK-FEE','رسوم بنكية','bank_fee'],
        ['REFUND-001','المرتجعات','refund'], ['ADJ-001','التسويات','adjustment'],
    ];
    $stmt = $pdo->prepare("INSERT OR IGNORE INTO financial_accounts (code,name,category) VALUES (?,?,?)");
    foreach ($accounts as $account) $stmt->execute($account);
}

function hsSettlementAccountForPaymentMethod(string $method): string {
    $normalized = strtolower(trim($method));
    if (in_array($normalized, ['نقدي', 'نقد', 'cash', 'cash payment'], true)) return 'CASH-001';
    if (preg_match('/بنكي|تحويل|شبكة|مدى|فيزا|ماستركارد|visa|master\s?card|card|بطاقة|pos/iu', $normalized) === 1) {
        return 'BANK-001';
    }
    throw new RuntimeException('طريقة الدفع غير مدعومة؛ اختر نقدي أو مدى أو بطاقة أو تحويلًا بنكيًا');
}

function hsInitialFinancialStatus(string $requestedStatus): string {
    $status = trim($requestedStatus);
    if ($status === '') return 'draft';
    if (in_array($status, ['draft', 'pending_approval'], true)) return $status;
    throw new RuntimeException('يجب بدء المستند المالي كمسودة أو إرساله للاعتماد؛ لا يُسمح بإنشائه مرحّلًا مباشرة');
}

function hsLegacyLedgerDirection(string $kind): string {
    return in_array($kind, ['expense', 'payment_return', 'purchase', 'purchase_return', 'bank_fee'], true)
        ? 'debit'
        : 'credit';
}

function hsPostFinancialCore(PDO $pdo, string $kind, int $sourceId, array $payload, string $reference, ?int $actorId): void {
    $amount = (float)($payload['amount'] ?? $payload['total'] ?? 0);
    if ($amount <= 0) throw new RuntimeException('لا يمكن ترحيل قيمة مالية غير موجبة');
    if ($kind === 'receipt' && !empty($payload['sourcePaymentId'])) return;
    $settlementAccount = in_array($kind, ['payment', 'receipt', 'payment_return'], true)
        ? hsSettlementAccountForPaymentMethod((string)($payload['paymentMethod'] ?? ''))
        : null;
    hsFinancialTables($pdo);
    $date = (string)($payload['date'] ?? date('Y-m-d'));
    $exists = $pdo->prepare("SELECT id FROM financial_transactions WHERE source_kind = ? AND source_id = ?");
    $exists->execute([$kind, $sourceId]);
    if ($exists->fetchColumn()) return;
    $period = substr($date, 0, 7);
    $periodStmt = $pdo->prepare("SELECT status FROM financial_periods WHERE period_key = ?");
    $periodStmt->execute([$period]);
    $periodStatus = $periodStmt->fetchColumn();
    if ($periodStatus === 'closed') throw new RuntimeException("الفترة المالية {$period} مغلقة");
    $periodEnd = date('Y-m-t', strtotime("{$period}-01"));
    $pdo->prepare("INSERT OR IGNORE INTO financial_periods (period_key,starts_on,ends_on,status) VALUES (?,?,?,'open')")
        ->execute([$period, "{$period}-01", $periodEnd]);
    $debit = 'ADJ-001'; $credit = 'CASH-001';
    if ($kind === 'invoice') [$debit,$credit] = ['AR-001','REV-001'];
    elseif ($kind === 'invoice_return') [$debit,$credit] = ['REV-001','AR-001'];
    elseif ($kind === 'payment' || $kind === 'receipt') [$debit,$credit] = [$settlementAccount,'AR-001'];
    elseif ($kind === 'payment_return') [$debit,$credit] = ['REFUND-001',$settlementAccount];
    elseif (in_array($kind,['expense','daily_expense','fuel_expense','salary_payment','salary_advance'],true)) [$debit,$credit] = ['EXP-001','CASH-001'];
    elseif ($kind === 'purchase') [$debit,$credit] = ['INV-001','AP-001'];
    elseif ($kind === 'purchase_return') [$debit,$credit] = ['AP-001','INV-001'];
    elseif ($kind === 'deposit' || $kind === 'bank_deposit') [$debit,$credit] = ['BANK-001','CASH-001'];
    elseif ($kind === 'other_revenue') [$debit,$credit] = ['CASH-001','REV-OTHER'];
    elseif ($kind === 'maintenance') [$debit,$credit] = ['EXP-MAINT','CASH-001'];
    elseif ($kind === 'commission') [$debit,$credit] = ['COMM-001','AP-001'];
    elseif ($kind === 'bank_fee') [$debit,$credit] = ['BANK-FEE','BANK-001'];
    elseif ($kind === 'transfer') [$debit,$credit] = ['BANK-001','CASH-001'];
    $pdo->prepare("INSERT INTO financial_transactions (transaction_number,transaction_type,source_kind,source_id,reference,transaction_date,amount,status,operation_key,created_by,posted_at) VALUES (?,?,?,?,?,?,?,'posted',?,?,?)")
        ->execute(["FT-{$sourceId}",$kind,$kind,$sourceId,$reference,$date,$amount,(string)($payload['operationKey'] ?? '') ?: null,$actorId,date('c')]);
    $txId = (int)$pdo->lastInsertId();
    $pdo->prepare("INSERT INTO financial_journal_entries (transaction_id,entry_number,total_debit,total_credit,status) VALUES (?,?,?,?,'posted')")
        ->execute([$txId,"FJ-{$txId}",$amount,$amount]);
    $entryId = (int)$pdo->lastInsertId();
    $line = $pdo->prepare("INSERT INTO financial_journal_lines (journal_entry_id,account_code,debit,credit,description) VALUES (?,?,?,?,?)");
    $line->execute([$entryId,$debit,$amount,0,"مدين — {$kind}"]);
    $line->execute([$entryId,$credit,0,$amount,"دائن — {$kind}"]);
    if (isset($payload['allocations']) && is_array($payload['allocations'])) {
        $allocation = $pdo->prepare("INSERT INTO financial_allocations (transaction_id,contract_id,invoice_id,amount) VALUES (?,?,?,?)");
        foreach ($payload['allocations'] as $item) $allocation->execute([$txId,(int)($item['contractId'] ?? 0) ?: null,(int)($item['invoiceId'] ?? 0) ?: null,(float)($item['amount'] ?? 0)]);
    }
}

function hsEnsureDepositReconciliation(PDO $pdo, int $depositRecordId, string $kind, array $payload, string $reference): void {
    if (!in_array($kind, ['deposit', 'bank_deposit'], true)) return;
    $financial = $pdo->prepare("SELECT id FROM financial_transactions WHERE source_kind = ? AND source_id = ? LIMIT 1");
    $financial->execute([$kind, $depositRecordId]);
    $financialTransactionId = (int)$financial->fetchColumn();
    if ($financialTransactionId <= 0) throw new RuntimeException('تعذر ربط الإيداع بالحركة المالية');
    $amount = (float)($payload['amount'] ?? $payload['total'] ?? 0);
    $date = (string)($payload['date'] ?? date('Y-m-d'));
    $depositReference = (string)($payload['reference'] ?? $reference);
    $pdo->prepare("INSERT INTO bank_reconciliations
        (deposit_record_id,deposit_reference,deposit_date,amount,linked_transaction_id,difference,status,audit_trail)
        SELECT ?,?,?,?,?,?,?,?
        WHERE NOT EXISTS (SELECT 1 FROM bank_reconciliations WHERE deposit_record_id = ?)")
        ->execute([$depositRecordId, $depositReference, $date, $amount, $financialTransactionId, 0, 'unmatched',
            json_encode([['at' => date('c'), 'action' => 'deposit_posted_not_bank_confirmed', 'sourceKind' => $kind, 'sourceId' => $depositRecordId]], JSON_UNESCAPED_UNICODE),
            $depositRecordId]);
}

function hsReverseFinancialCore(PDO $pdo, string $kind, int $sourceId, float $amount, string $reason, ?int $actorId): void {
    hsFinancialTables($pdo);
    $original = $pdo->prepare("SELECT id FROM financial_transactions WHERE source_kind = ? AND source_id = ? AND status = 'posted' LIMIT 1");
    $original->execute([$kind, $sourceId]);
    $originalId = $original->fetchColumn();
    if (!$originalId) return;
    $existing = $pdo->prepare("SELECT id FROM financial_transactions WHERE source_kind = 'reversal' AND source_id = ? LIMIT 1");
    $existing->execute([$sourceId]);
    if ($existing->fetchColumn()) return;
    $date = date('Y-m-d');
    $period = substr($date, 0, 7);
    $periodStmt = $pdo->prepare("SELECT status FROM financial_periods WHERE period_key = ?");
    $periodStmt->execute([$period]);
    if ($periodStmt->fetchColumn() === 'closed') throw new RuntimeException("الفترة المالية {$period} مغلقة");
    $periodEnd = date('Y-m-t', strtotime("{$period}-01"));
    $pdo->prepare("INSERT OR IGNORE INTO financial_periods (period_key,starts_on,ends_on,status) VALUES (?,?,?,'open')")
        ->execute([$period, "{$period}-01", $periodEnd]);
    $pdo->prepare("INSERT INTO financial_transactions (transaction_number,transaction_type,source_kind,source_id,reference,transaction_date,amount,status,operation_key,created_by,posted_at,cancellation_reason) VALUES (?,?,?,?,?,?,?,'posted',?,?,?,?)")
        ->execute(["FT-REV-{$sourceId}", 'reversal', 'reversal', $sourceId, "REV-{$sourceId}", $date, $amount, "reversal:{$kind}:{$sourceId}", $actorId, date('c'), $reason]);
    $reversalId = (int)$pdo->lastInsertId();
    $originalJournal = $pdo->prepare("SELECT id FROM financial_journal_entries WHERE transaction_id = ? LIMIT 1");
    $originalJournal->execute([(int)$originalId]);
    $originalJournalId = $originalJournal->fetchColumn();
    $pdo->prepare("INSERT INTO financial_journal_entries (transaction_id,entry_number,total_debit,total_credit,status) VALUES (?,?,?,?,'posted')")
        ->execute([$reversalId, "FJ-REV-{$reversalId}", $amount, $amount]);
    $reversalJournalId = (int)$pdo->lastInsertId();
    $lines = $pdo->prepare("SELECT account_code,debit,credit,description FROM financial_journal_lines WHERE journal_entry_id = ?");
    $lines->execute([(int)$originalJournalId]);
    $insert = $pdo->prepare("INSERT INTO financial_journal_lines (journal_entry_id,account_code,debit,credit,description) VALUES (?,?,?,?,?)");
    foreach ($lines->fetchAll(PDO::FETCH_ASSOC) as $line) {
        $insert->execute([$reversalJournalId, $line['account_code'], (float)$line['credit'], (float)$line['debit'], 'عكس: ' . $line['description']]);
    }
}

function hsFinancialTruth(PDO $pdo, ?string $from = null, ?string $to = null): array {
    hsFinancialTables($pdo);
    $from = $from && preg_match('/^\d{4}-\d{2}-\d{2}$/', $from) ? $from : null;
    $to = $to && preg_match('/^\d{4}-\d{2}-\d{2}$/', $to) ? $to : null;
    $rowStmt = $pdo->prepare("SELECT
        COALESCE(SUM(CASE WHEN jl.account_code IN ('CASH-001','BANK-001') THEN jl.debit-jl.credit ELSE 0 END),0) cashAndBank,
        COALESCE(SUM(CASE WHEN jl.account_code='CASH-001' THEN jl.debit-jl.credit ELSE 0 END),0) cashBalance,
        COALESCE(SUM(CASE WHEN jl.account_code='BANK-001' THEN jl.debit-jl.credit ELSE 0 END),0) bankBalance,
        COALESCE(SUM(CASE WHEN jl.account_code LIKE 'REV%' THEN jl.credit-jl.debit ELSE 0 END),0) grossRevenue,
        COALESCE(SUM(CASE WHEN jl.account_code='REFUND-001' THEN jl.debit-jl.credit ELSE 0 END),0) refunds,
        COALESCE(SUM(CASE WHEN jl.account_code LIKE 'EXP%' OR jl.account_code IN ('COMM-001','COGS-001','BANK-FEE') THEN jl.debit-jl.credit ELSE 0 END),0) expenses,
        COALESCE(SUM(CASE WHEN jl.account_code='COMM-001' THEN jl.debit-jl.credit ELSE 0 END),0) commissions,
        COALESCE(SUM(CASE WHEN jl.account_code='BANK-FEE' THEN jl.debit-jl.credit ELSE 0 END),0) bankFees,
        COALESCE(SUM(CASE WHEN jl.account_code='INV-001' THEN jl.debit-jl.credit ELSE 0 END),0) inventory,
        COALESCE(SUM(CASE WHEN jl.account_code='AR-001' THEN jl.debit-jl.credit ELSE 0 END),0) receivables,
        COALESCE(SUM(CASE WHEN jl.account_code='AP-001' THEN jl.credit-jl.debit ELSE 0 END),0) payables,
        COALESCE(SUM(jl.debit),0) totalDebit, COALESCE(SUM(jl.credit),0) totalCredit
        FROM financial_journal_entries je
        JOIN financial_transactions ft ON ft.id=je.transaction_id
        JOIN financial_journal_lines jl ON jl.journal_entry_id=je.id
        WHERE je.status='posted' AND ft.status='posted'
          AND (:from IS NULL OR ft.transaction_date >= :from)
          AND (:to IS NULL OR ft.transaction_date <= :to)");
    $rowStmt->execute([':from' => $from, ':to' => $to]);
    $row = $rowStmt->fetch(PDO::FETCH_ASSOC) ?: [];
    $collectionStmt = $pdo->prepare("SELECT
        COALESCE(SUM(CASE WHEN transaction_type IN ('payment','receipt') THEN amount ELSE 0 END),0) grossCollections,
        COALESCE(SUM(CASE WHEN transaction_type='payment_return' THEN amount ELSE 0 END),0) returnedCollections
        FROM financial_transactions
        WHERE status='posted'
          AND (:from IS NULL OR transaction_date >= :from)
          AND (:to IS NULL OR transaction_date <= :to)");
    $collectionStmt->execute([':from' => $from, ':to' => $to]);
    $collections = $collectionStmt->fetch(PDO::FETCH_ASSOC) ?: [];
    $depositStmt = $pdo->prepare("SELECT COALESCE(SUM(amount),0) deposits
        FROM financial_transactions
        WHERE status='posted' AND transaction_type IN ('deposit','bank_deposit')
          AND (:from IS NULL OR transaction_date >= :from)
          AND (:to IS NULL OR transaction_date <= :to)");
    $depositStmt->execute([':from' => $from, ':to' => $to]);
    $row['deposits'] = (float)($depositStmt->fetchColumn() ?: 0);
    $row['revenue'] = round((float)($row['grossRevenue'] ?? 0) - (float)($row['refunds'] ?? 0), 2);
    $row['netCollections'] = round((float)($collections['grossCollections'] ?? 0) - (float)($collections['returnedCollections'] ?? 0), 2);
    $row['grossCollections'] = (float)($collections['grossCollections'] ?? 0);
    $row['returnedCollections'] = (float)($collections['returnedCollections'] ?? 0);
    $row['collected'] = $row['netCollections'];
    $row['purchases'] = (float)($row['inventory'] ?? 0);
    $row['transfers'] = 0.0;
    $row['netProfit'] = round((float)$row['revenue'] - (float)($row['expenses'] ?? 0), 2);
    $row['balances'] = [
        'accountsReceivable' => (float)($row['receivables'] ?? 0),
        'accountsPayable' => (float)($row['payables'] ?? 0),
        'cash' => (float)($row['cashBalance'] ?? 0),
        'bank' => (float)($row['bankBalance'] ?? 0),
        'inventory' => (float)($row['inventory'] ?? 0),
    ];
    $countStmt = $pdo->prepare("SELECT transaction_type kind, COUNT(*) count
        FROM financial_transactions WHERE status='posted'
          AND (:from IS NULL OR transaction_date >= :from)
          AND (:to IS NULL OR transaction_date <= :to)
        GROUP BY transaction_type ORDER BY transaction_type");
    $countStmt->execute([':from' => $from, ':to' => $to]);
    $counts = $countStmt->fetchAll(PDO::FETCH_ASSOC);
    return ['totals' => $row, 'counts' => $counts];
}

function hsPrepareServiceRequestsTable(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS service_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        email TEXT,
        service_type TEXT NOT NULL,
        container_size TEXT,
        container_count INTEGER NOT NULL DEFAULT 1,
        property_type TEXT,
        area_size TEXT,
        location TEXT NOT NULL,
        duration TEXT,
        notes TEXT,
        appointment_type TEXT NOT NULL DEFAULT 'immediate',
        scheduled_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        admin_notes TEXT,
        customer_record_id INTEGER,
        container_record_id INTEGER,
        contract_record_id INTEGER,
        assigned_driver_id INTEGER,
        assigned_vehicle_id INTEGER,
        assigned_vehicle_plate TEXT,
        driver_status TEXT NOT NULL DEFAULT 'unassigned',
        driver_response_at TEXT,
        driver_started_at TEXT,
        driver_completed_at TEXT,
        driver_notes TEXT,
        driver_location_lat TEXT,
        driver_location_lng TEXT,
        driver_proof_photo_url TEXT,
        driver_signature_data TEXT,
        driver_receiver_name TEXT,
        assigned_at TEXT,
        session_id TEXT NOT NULL DEFAULT '',
        acquisition_source TEXT NOT NULL DEFAULT 'مباشر',
        attribution_referrer TEXT NOT NULL DEFAULT '',
        attribution_landing_page TEXT NOT NULL DEFAULT '',
        attribution_utm_source TEXT NOT NULL DEFAULT '',
        attribution_utm_medium TEXT NOT NULL DEFAULT '',
        attribution_utm_campaign TEXT NOT NULL DEFAULT '',
        attribution_gclid TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )");
}

function hsEnsureSchema(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS container_system_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        reference TEXT NOT NULL DEFAULT '',
        payload TEXT NOT NULL DEFAULT '{}',
        created_by INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )");
    $pdo->exec("CREATE TABLE IF NOT EXISTS container_system_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id INTEGER,
        kind TEXT NOT NULL,
        action TEXT NOT NULL,
        before_payload TEXT,
        after_payload TEXT,
        actor_id INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )");
    try { $pdo->exec("ALTER TABLE container_system_records ADD COLUMN operation_key TEXT"); } catch (Throwable $migrationError) { /* already exists */ }
    try {
        $pdo->exec("UPDATE container_system_records SET operation_key = json_extract(payload, '$.operationKey') WHERE operation_key IS NULL AND json_extract(payload, '$.operationKey') IS NOT NULL");
    } catch (Throwable $jsonError) { /* legacy SQLite without JSON1 */ }
    $pdo->exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_container_system_records_operation_key ON container_system_records(kind, operation_key) WHERE operation_key IS NOT NULL AND operation_key <> '' AND status <> 'archived'");
    hsFinancialTables($pdo);
    $columns = $pdo->query("PRAGMA table_info(service_requests)")->fetchAll(PDO::FETCH_ASSOC);
    $known = array_fill_keys(array_map(static fn(array $column): string => (string)$column['name'], $columns), true);
    $migrations = [
        'customer_record_id' => 'INTEGER',
        'container_record_id' => 'INTEGER',
        'contract_record_id' => 'INTEGER',
        'driver_location_lat' => 'TEXT',
        'driver_location_lng' => 'TEXT',
        'driver_proof_photo_url' => 'TEXT',
        'driver_signature_data' => 'TEXT',
        'driver_receiver_name' => 'TEXT',
        'driver_response_at' => 'TEXT',
        'driver_started_at' => 'TEXT',
        'driver_completed_at' => 'TEXT',
        'driver_notes' => 'TEXT',
        'driver_status' => "TEXT NOT NULL DEFAULT 'unassigned'",
        'assigned_driver_id' => 'INTEGER',
        'assigned_at' => 'TEXT',
    ];
    foreach ($migrations as $column => $type) {
        if (!isset($known[$column])) {
            $pdo->exec("ALTER TABLE service_requests ADD COLUMN {$column} {$type}");
        }
    }
}

function hsCreateProvisionalCustomerForRequest(PDO $pdo, array $request): ?int {
    $requestId = (int)($request['id'] ?? 0);
    $phone = trim((string)($request['phone'] ?? ''));
    if ($requestId <= 0 || $phone === '') return null;

    $link = $pdo->prepare('SELECT customer_record_id FROM service_requests WHERE id = ? LIMIT 1');
    $link->execute([$requestId]);
    $existingLink = (int)($link->fetchColumn() ?: 0);
    if ($existingLink > 0) return $existingLink;

    $ownsTransaction = !$pdo->inTransaction();
    if ($ownsTransaction) $pdo->beginTransaction();
    try {
        $now = date('c');
        $customerReference = 'CUS-' . str_pad((string)$requestId, 5, '0', STR_PAD_LEFT);
        $findCustomer = $pdo->prepare("SELECT id FROM container_system_records WHERE kind = 'customer' AND reference = ? LIMIT 1");
        $findCustomer->execute([$customerReference]);
        $customerId = (int)($findCustomer->fetchColumn() ?: 0);
        if ($customerId <= 0) {
            $customerPayload = [
                'name' => trim((string)($request['client_name'] ?? '')) ?: 'عميل الطلب',
                'phone' => $phone,
                'email' => (string)($request['email'] ?? ''),
                'source' => 'service_request',
                'firstRequestId' => $requestId,
                'lastRequestId' => $requestId,
                'identityVerification' => 'unverified',
                'identityReviewStatus' => 'pending',
            ];
            $insertCustomer = $pdo->prepare("INSERT INTO container_system_records
                (kind, status, reference, payload, created_at, updated_at)
                VALUES ('customer', 'active', ?, ?, ?, ?)");
            $insertCustomer->execute([
                $customerReference,
                json_encode($customerPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE),
                $now,
                $now,
            ]);
            $customerId = (int)$pdo->lastInsertId();
        }

        $location = trim((string)($request['location'] ?? ''));
        if ($location !== '' && $location !== 'غير محدد') {
            $siteReference = 'SITE-' . str_pad((string)$requestId, 5, '0', STR_PAD_LEFT);
            $findSite = $pdo->prepare("SELECT id FROM container_system_records WHERE kind = 'customer_site' AND reference = ? LIMIT 1");
            $findSite->execute([$siteReference]);
            if (!(int)$findSite->fetchColumn()) {
                $sitePayload = [
                    'customerRecordId' => $customerId,
                    'name' => trim((string)($request['client_name'] ?? '')) . ' — عنوان الطلب #' . $requestId,
                    'address' => $location,
                    'location' => $location,
                    'requestId' => $requestId,
                    'source' => 'service_request',
                    'serviceType' => (string)($request['service_type'] ?? ''),
                ];
                $insertSite = $pdo->prepare("INSERT INTO container_system_records
                    (kind, status, reference, payload, created_at, updated_at)
                    VALUES ('customer_site', 'active', ?, ?, ?, ?)");
                $insertSite->execute([
                    $siteReference,
                    json_encode($sitePayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE),
                    $now,
                    $now,
                ]);
            }
        }

        $updateRequest = $pdo->prepare("UPDATE service_requests SET customer_record_id = ?
            WHERE id = ? AND (customer_record_id IS NULL OR customer_record_id = 0)");
        $updateRequest->execute([$customerId, $requestId]);
        $link->execute([$requestId]);
        $linkedCustomerId = (int)($link->fetchColumn() ?: 0);
        if ($ownsTransaction) $pdo->commit();
        return $linkedCustomerId > 0 ? $linkedCustomerId : $customerId;
    } catch (Throwable $error) {
        if ($ownsTransaction && $pdo->inTransaction()) $pdo->rollBack();
        throw $error;
    }
}

function hsSyncRequestsToCustomers(PDO $pdo): void {
    $requests = $pdo->query("SELECT id, client_name, phone, email, service_type, location, created_at, customer_record_id
        FROM service_requests WHERE customer_record_id IS NULL OR customer_record_id = 0 ORDER BY id ASC")
        ->fetchAll(PDO::FETCH_ASSOC);
    foreach ($requests as $request) {
        // Legacy linked customers are left untouched; unverified phone matches
        // must never rewrite or claim an existing profile during backfill.
        hsCreateProvisionalCustomerForRequest($pdo, $request);
    }
}

function hsAuth(PDO $pdo, bool $managerOnly = false): array {
    $header = getAuthHeader();
    if (!$header || !preg_match('/^Bearer\s+(.+)$/i', $header, $matches)) {
        hsJson(['error' => 'Unauthorized'], 401);
    }
    $token = verifyToken($matches[1]);
    if (!$token || empty($token['adminId'])) hsJson(['error' => 'Unauthorized'], 401);
    $stmt = $pdo->prepare("SELECT * FROM admins WHERE id = :id LIMIT 1");
    $stmt->execute([':id' => (int)$token['adminId']]);
    $admin = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$admin || (isset($admin['is_active']) && (int)$admin['is_active'] === 0)) {
        hsJson(['error' => 'Unauthorized'], 401);
    }
    if ($managerOnly && !in_array((string)($admin['role'] ?? ''), ['admin', 'manager'], true)) {
        hsJson(['error' => 'ليس لديك صلاحية لهذه العملية'], 403);
    }
    $admin['id'] = (int)$admin['id'];
    return $admin;
}

function hsCanManage(array $admin, string $kind): bool {
    if (in_array((string)($admin['role'] ?? ''), ['admin', 'manager'], true)) return true;
    $permissions = json_decode((string)($admin['permissions'] ?? '[]'), true);
    if (!is_array($permissions)) $permissions = [];
    return in_array('container_system', $permissions, true)
        || in_array('container_system_' . $kind, $permissions, true);
}

function hsSupportedKinds(): array {
    return [
        'customer', 'customer_site', 'container_type', 'container', 'container_asset', 'container_assignment', 'vehicle', 'driver',
        'contract', 'contract_line', 'container_movement', 'ledger_entry', 'receipt', 'payment',
        'expense', 'deposit', 'bank_deposit', 'bank_fee', 'maintenance', 'alert', 'setting', 'branch',
        'employee', 'permit', 'appointment', 'warehouse', 'supplier', 'treasury', 'transfer', 'invoice',
        'invoice_return', 'category', 'category_size', 'tax', 'commission', 'oil_change',
        'salary_advance', 'salary_payment', 'fuel_expense', 'daily_expense',
        'other_revenue', 'notification', 'payment_return', 'stock_issue', 'stock_issue_return',
        'purchase', 'purchase_return',
        'work_order',
    ];
}

function hsFinancialLifecycleKinds(): array {
    return ['receipt', 'payment', 'expense', 'deposit', 'bank_deposit', 'bank_fee', 'invoice', 'invoice_return',
        'payment_return', 'transfer', 'purchase', 'purchase_return', 'commission', 'salary_advance',
        'salary_payment', 'fuel_expense', 'daily_expense', 'other_revenue'];
}

function hsValidateFinancialLifecycle(array $admin, string $kind, string $current, string $next, array $payload): void {
    if (!in_array($kind, hsFinancialLifecycleKinds(), true) || $current === $next) return;
    $allowed = [
        'draft' => ['pending_approval', 'rejected', 'cancelled'],
        'pending_approval' => ['approved', 'rejected', 'cancelled'],
        'approved' => ['posted', 'cancelled'],
        'posted' => ['cancelled'],
        'rejected' => ['draft', 'cancelled'],
        'cancelled' => [],
    ];
    if (!isset($allowed[$next]) || !in_array($next, $allowed[$current] ?? [], true)) {
        hsJson(['error' => 'انتقال الحركة المالية غير مسموح؛ استخدم دورة الاعتماد بالترتيب'], 422);
    }
    if (in_array($next, ['approved', 'posted', 'cancelled'], true)
        && !in_array((string)($admin['role'] ?? ''), ['admin', 'manager'], true)) {
        hsJson(['error' => 'اعتماد أو إلغاء الحركة المالية يتطلب صلاحية المدير'], 422);
    }
    if ($next === 'cancelled' && mb_strlen(trim((string)($payload['cancellationReason'] ?? $payload['reason'] ?? ''))) < 3) {
        hsJson(['error' => 'سبب إلغاء الحركة المالية مطلوب'], 422);
    }
}

function hsReference(string $kind, array $payload, int $id): string {
    if (!empty($payload['reference'])) return (string)$payload['reference'];
    if (!empty($payload['code'])) return (string)$payload['code'];
    $prefix = [
        'customer' => 'CUS', 'container' => 'CONT', 'container_asset' => 'CONT',
        'container_type' => 'CT', 'vehicle' => 'CAR', 'driver' => 'DRV',
        'contract' => 'RNT', 'contract_line' => 'LINE', 'customer_site' => 'SITE', 'container_assignment' => 'ASN', 'invoice' => 'INV',
        'receipt' => 'RCV', 'payment' => 'PAY', 'expense' => 'EXP',
        'maintenance' => 'MNT', 'bank_deposit' => 'DEP', 'appointment' => 'APT',
    ][$kind] ?? 'REC';
    return $prefix . '-' . str_pad((string)$id, 5, '0', STR_PAD_LEFT);
}

function hsAssetCode(array $payload): string {
    return trim((string)($payload['assetCode'] ?? $payload['code'] ?? ''));
}

function hsCanonicalAssetStatus(string $value, string $fallback = 'available'): string {
    $aliases = [
        'متاح' => 'available', 'متاحة' => 'available', 'جاهز' => 'available',
        'جاهزة' => 'available', 'مؤجر' => 'rented', 'مؤجرة' => 'rented',
        'لدى العميل' => 'rented', 'في الطريق' => 'in_transit', 'تحت الفحص' => 'inspection',
        'صيانة' => 'maintenance', 'في الصيانة' => 'maintenance', 'تالف' => 'damaged',
        'تالفة' => 'damaged', 'مفقود' => 'lost', 'مفقودة' => 'lost',
        'خارج الخدمة' => 'out_of_service',
    ];
    $value = trim(mb_strtolower($value));
    return $aliases[$value] ?? ($value !== '' ? $value : $fallback);
}

function hsMovementStatus(string $type): ?string {
    $type = mb_strtolower(trim($type));
    return [
        'delivery' => 'rented', 'deliver' => 'rented', 'تسليم' => 'rented',
        'replacement' => 'in_transit', 'swap' => 'in_transit', 'تبديل' => 'in_transit',
        'تبديل حاوية' => 'in_transit', 'unloading' => 'in_transit', 'emptying' => 'in_transit',
        'تفريغ' => 'in_transit', 'withdrawal' => 'in_transit', 'withdraw' => 'in_transit',
        'سحب' => 'in_transit', 'return' => 'available', 'returned' => 'available',
        'استرجاع' => 'available', 'maintenance' => 'maintenance', 'صيانة' => 'maintenance',
    ][$type] ?? null;
}

function hsMovementAllowed(string $current, string $type): bool {
    $current = hsCanonicalAssetStatus($current, $current);
    $type = mb_strtolower(trim($type));
    if (in_array($type, ['delivery', 'deliver', 'تسليم'], true)) return in_array($current, ['available', 'reserved', 'inspection'], true);
    if (in_array($type, ['replacement', 'swap', 'تبديل', 'تبديل حاوية', 'unloading', 'emptying', 'تفريغ', 'withdrawal', 'withdraw', 'سحب'], true)) {
        return in_array($current, ['rented', 'with_customer', 'awaiting_return', 'in_transit'], true);
    }
    if (in_array($type, ['return', 'returned', 'استرجاع'], true)) return in_array($current, ['rented', 'with_customer', 'awaiting_return', 'in_transit', 'damaged'], true);
    if (in_array($type, ['maintenance', 'صيانة'], true)) return !in_array($current, ['lost', 'out_of_service'], true);
    return false;
}

function hsFindRecords(PDO $pdo, ?string $kind = null, ?string $status = null, string $search = ''): array {
    $sql = "SELECT * FROM container_system_records WHERE 1=1";
    $params = [];
    if ($kind) { $sql .= " AND kind = :kind"; $params[':kind'] = $kind; }
    if ($status) { $sql .= " AND status = :status"; $params[':status'] = $status; }
    if ($search !== '') { $sql .= " AND payload LIKE :search"; $params[':search'] = '%' . $search . '%'; }
    $sql .= " ORDER BY updated_at DESC, id DESC";
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function hsFindAsset(PDO $pdo, string $code): ?array {
    $code = trim($code);
    if ($code === '') return null;
    foreach (hsFindRecords($pdo) as $row) {
        if (in_array($row['kind'], ['container', 'container_asset'], true) && $row['status'] !== 'archived' && hsAssetCode(hsPayload($row['payload'])) === $code) return $row;
    }
    return null;
}

function hsApplyRequestContainerType(array &$contract, array $service, array $assetPayload): void {
    $requestType = trim((string)($service['containerSize'] ?? ''));
    $assetType = trim((string)($assetPayload['typeName'] ?? $assetPayload['containerType'] ?? $assetPayload['size'] ?? ''));
    if ($requestType === '' && $assetType === '') return;
    // The selected asset is the authoritative central type when available.
    // Otherwise preserve the type captured in the service request so old
    // Hostinger records still carry the request's container selection.
    $resolvedType = $assetType !== '' ? $assetType : $requestType;
    $contract['containerType'] = $resolvedType;
    $contract['typeName'] = $resolvedType;
    $contract['containerSize'] = trim((string)($assetPayload['size'] ?? '')) ?: ($requestType !== '' ? $requestType : $resolvedType);
    if (isset($assetPayload['containerTypeId']) || isset($assetPayload['containerTypeRecordId'])) {
        $contract['containerTypeId'] = (int)($assetPayload['containerTypeId'] ?? $assetPayload['containerTypeRecordId']);
    }
}

function hsNormalizeFinancial(string $kind, array $payload): array {
    $payload['currency'] = strtoupper(trim((string)($payload['currency'] ?? 'SAR'))) ?: 'SAR';
    $amount = (float)($payload['amount'] ?? $payload['subtotal'] ?? 0);
    $taxRate = (float)($payload['taxRate'] ?? ($kind === 'contract' ? 0 : 15));
    if ($kind === 'invoice' || $kind === 'contract') {
        $payload['taxRate'] = $taxRate;
        $taxEnabled = ($payload['taxEnabled'] ?? false) === true || in_array(strtolower((string)($payload['taxEnabled'] ?? '')), ['true', '1', 'yes', 'نعم'], true);
        $payload['taxEnabled'] = $taxEnabled;
        if (!$taxEnabled) {
            $payload['taxAmount'] = 0;
            $payload['amount'] = round($amount, 2);
            $payload['total'] = round($amount, 2);
        } elseif (($payload['taxInclusive'] ?? false) === true || strtolower((string)($payload['taxInclusive'] ?? '')) === 'true') {
            $payload['total'] = round($amount, 2);
            $payload['taxAmount'] = round($amount - ($amount / (1 + $taxRate / 100)), 2);
            $payload['amount'] = round($amount - $payload['taxAmount'], 2);
        } else {
            $payload['amount'] = round($amount, 2);
            $payload['taxAmount'] = round($amount * $taxRate / 100, 2);
            $payload['total'] = round($amount + $payload['taxAmount'], 2);
        }
        $payload['subtotal'] = $payload['amount'];
    }
    return $payload;
}

function hsContractHasOverlappingDates(PDO $pdo, array $payload, ?int $ignoreId = null): bool {
    $containerCode = trim((string)($payload['containerCode'] ?? ''));
    $start = strtotime((string)($payload['startDate'] ?? ''));
    $end = strtotime((string)($payload['endDate'] ?? ''));
    if ($containerCode === '' || $start === false || $end === false) return false;
    foreach (hsFindRecords($pdo) as $row) {
        if (($row['kind'] ?? '') !== 'contract'
            || ($row['status'] ?? '') === 'archived'
            || (int)($row['id'] ?? 0) === $ignoreId
            || !in_array((string)($row['status'] ?? ''), ['active', 'issued', 'scheduled', 'delivered'], true)) {
            continue;
        }
        $current = hsPayload($row['payload'] ?? '');
        if (trim((string)($current['containerCode'] ?? '')) !== $containerCode) continue;
        $currentStart = strtotime((string)($current['startDate'] ?? ''));
        $currentEnd = strtotime((string)($current['endDate'] ?? ''));
        if ($currentStart !== false && $currentEnd !== false && $start <= $currentEnd && $end >= $currentStart) {
            return true;
        }
    }
    return false;
}

function hsContractCategory(array $payload): string {
    $values = [
        $payload['category'] ?? '',
        $payload['classification'] ?? '',
        $payload['categoryName'] ?? '',
        $payload['contractCategory'] ?? '',
        $payload['contractType'] ?? '',
    ];
    foreach ($values as $value) {
        $normalized = mb_strtolower(trim((string)$value));
        if (preg_match('/waste|نفايات|مكبس/u', $normalized)) return 'waste';
        if (preg_match('/debris|أنقاض|مخلفات بناء|هدم/u', $normalized)) return 'debris';
        if (preg_match('/contract|نظافة|تنظيف/u', $normalized)) return 'contract';
    }
    return '';
}

function hsContractBusinessIdentifierError(PDO $pdo, array $payload): ?string {
    if (hsContractCategory($payload) !== 'waste') return null;
    $customerId = (int)($payload['customerRecordId'] ?? 0);
    $customerPayload = [];
    foreach (hsFindRecords($pdo, 'customer') as $candidate) {
        if ((int)$candidate['id'] === $customerId && $candidate['status'] !== 'archived') {
            $customerPayload = hsPayload($candidate['payload']);
            break;
        }
    }
    $commercialRegistration = trim((string)(
        $payload['customerCommercialRegistration'] ??
        $payload['commercialRegistration'] ??
        $customerPayload['commercialRegistration'] ??
        $customerPayload['commercialRegistrationNumber'] ??
        $customerPayload['crNumber'] ??
        $customerPayload['registrationNumber'] ??
        ''
    ));
    $taxNumber = trim((string)(
        $payload['customerTaxNumber'] ??
        $payload['taxNumber'] ??
        $customerPayload['taxNumber'] ??
        $customerPayload['vatNumber'] ??
        $customerPayload['taxId'] ??
        ''
    ));
    if ($commercialRegistration === '') return 'السجل التجاري للعميل مطلوب لعقود النفايات';
    if ($taxNumber === '') return 'الرقم الضريبي للعميل مطلوب لعقود النفايات';
    return null;
}

function hsHasActiveContainerAssignment(PDO $pdo, int $containerId): bool {
    foreach (hsFindRecords($pdo) as $row) {
        if (($row['kind'] ?? '') !== 'container_assignment' || ($row['status'] ?? '') === 'archived') continue;
        $payload = hsPayload($row['payload'] ?? '');
        $assignmentStatus = mb_strtolower((string)($payload['assignmentStatus'] ?? $row['status'] ?? ''));
        if ((int)($payload['containerRecordId'] ?? 0) === $containerId
            && in_array($assignmentStatus, ['reserved', 'active'], true)) {
            return true;
        }
    }
    return false;
}

function hsValidateRecord(PDO $pdo, string $kind, array $payload, ?int $ignoreId = null): void {
    $financial = ['payment', 'receipt', 'expense', 'deposit', 'bank_deposit', 'bank_fee', 'invoice', 'invoice_return',
        'payment_return', 'transfer', 'purchase', 'purchase_return', 'commission', 'salary_advance',
        'salary_payment', 'fuel_expense', 'daily_expense'];
    if (in_array($kind, $financial, true)) {
        $amount = (float)($payload['amount'] ?? $payload['total'] ?? 0);
        if (!is_finite($amount) || $amount <= 0) hsJson(['error' => 'القيمة المالية يجب أن تكون أكبر من صفر'], 422);
    }
    if (in_array($kind, ['payment', 'receipt'], true) && trim((string)($payload['contractNumber'] ?? '')) === '' && trim((string)($payload['invoiceNumber'] ?? '')) === '') {
        hsJson(['error' => 'سند التحصيل يجب أن يرتبط برقم عقد أو فاتورة'], 422);
    }
    if ($kind === 'transfer') {
        $from = trim((string)($payload['fromTreasury'] ?? $payload['fromTreasuryId'] ?? ''));
        $to = trim((string)($payload['toTreasury'] ?? $payload['toTreasuryId'] ?? ''));
        if ($from === '' || $to === '') hsJson(['error' => 'الخزينة المصدر والخزينة المستلمة مطلوبتان'], 422);
        if ($from === $to) hsJson(['error' => 'لا يمكن التحويل إلى نفس الخزينة'], 422);
        $treasuries = hsFindRecords($pdo, 'treasury');
        foreach ([$from, $to] as $treasuryId) {
            $found = false;
            foreach ($treasuries as $treasury) {
                $tp = hsPayload($treasury['payload']);
                if ((string)$treasury['id'] === $treasuryId || (string)($tp['code'] ?? $treasury['reference']) === $treasuryId) { $found = true; break; }
            }
            if (!$found) hsJson(['error' => 'الخزينة المرتبطة بالتحويل غير موجودة'], 422);
        }
    }
    $rows = hsFindRecords($pdo);
    if (in_array($kind, ['payment', 'receipt', 'invoice', 'invoice_return', 'payment_return'], true)) {
        $customerId = (int)($payload['customerRecordId'] ?? 0);
        if ($customerId > 0) {
            $customer = array_filter($rows, static fn(array $row): bool =>
                (int)$row['id'] === $customerId && $row['kind'] === 'customer' && $row['status'] !== 'archived');
            if (!$customer) hsJson(['error' => 'العميل الرسمي المرتبط بالمستند غير موجود'], 422);
        } elseif ($kind === 'invoice') {
            hsJson(['error' => 'اختيار العميل الرسمي مطلوب قبل إصدار الفاتورة'], 422);
        }
        $contractNumber = trim((string)($payload['contractNumber'] ?? ''));
        if ($contractNumber !== '' && in_array($kind, ['payment', 'receipt', 'invoice', 'invoice_return'], true)) {
            $contract = array_filter($rows, static fn(array $row): bool =>
                $row['kind'] === 'contract' && $row['status'] !== 'archived' &&
                trim((string)(hsPayload($row['payload'])['contractNumber'] ?? $row['reference'])) === $contractNumber);
            if (!$contract) hsJson(['error' => 'العقد المرتبط بالمستند المالي غير موجود'], 422);
            $contractRow = array_values($contract)[0];
            if ($customerId > 0 && (int)(hsPayload($contractRow['payload'])['customerRecordId'] ?? 0) !== $customerId) {
                hsJson(['error' => 'العقد لا يتبع العميل المحدد في المستند'], 422);
            }
        }
        $invoiceNumber = trim((string)($payload['invoiceNumber'] ?? ''));
        if ($invoiceNumber !== '' && in_array($kind, ['payment', 'receipt', 'invoice_return', 'payment_return'], true)) {
            $invoice = array_filter($rows, static fn(array $row): bool =>
                $row['kind'] === 'invoice' && $row['status'] !== 'archived' &&
                trim((string)(hsPayload($row['payload'])['invoiceNumber'] ?? $row['reference'])) === $invoiceNumber);
            if (!$invoice) hsJson(['error' => 'الفاتورة المرتبطة بالمستند المالي غير موجودة'], 422);
            $invoiceRow = array_values($invoice)[0];
            if ($customerId > 0 && (int)(hsPayload($invoiceRow['payload'])['customerRecordId'] ?? 0) !== $customerId) {
                hsJson(['error' => 'الفاتورة لا تتبع العميل المحدد في المستند'], 422);
            }
            if ($kind === 'invoice_return') {
                $invoicePayload = hsPayload($invoiceRow['payload']);
                $invoiceTotal = (float)($invoicePayload['total'] ?? $invoicePayload['amount'] ?? 0);
                $returned = array_sum(array_map(static fn(array $row): float =>
                    (float)(hsPayload($row['payload'])['amount'] ?? 0),
                    array_filter($rows, static fn(array $row): bool =>
                        $row['kind'] === 'invoice_return' && $row['status'] === 'posted' &&
                        trim((string)(hsPayload($row['payload'])['invoiceNumber'] ?? '')) === $invoiceNumber)
                ));
                if ($invoiceTotal > 0 && (float)($payload['amount'] ?? 0) + $returned > $invoiceTotal + 0.01) {
                    hsJson(['error' => 'قيمة المرتجع تتجاوز الرصيد المتبقي من الفاتورة'], 422);
                }
            }
        }
    }
    if ($kind === 'invoice_return' && trim((string)($payload['invoiceNumber'] ?? $payload['originalInvoiceNumber'] ?? '')) === '') {
        hsJson(['error' => 'يجب تحديد الفاتورة الأصلية قبل تسجيل المرتجع'], 422);
    }
    if ($kind === 'payment_return') {
        $originalId = (int)($payload['originalPaymentId'] ?? 0);
        if ($originalId <= 0) hsJson(['error' => 'يجب تحديد السداد الأصلي قبل تسجيل مرتجع السداد'], 422);
        $original = array_filter($rows, static fn(array $row): bool =>
            (int)$row['id'] === $originalId && in_array($row['kind'], ['payment', 'receipt'], true) && $row['status'] === 'posted');
        if (!$original) hsJson(['error' => 'السداد الأصلي للمرتجع غير موجود أو غير مرحّل'], 422);
        $originalRow = array_values($original)[0];
        $originalAmount = (float)(hsPayload($originalRow['payload'])['amount'] ?? 0);
        $returned = array_sum(array_map(static fn(array $row): float =>
            (float)(hsPayload($row['payload'])['amount'] ?? 0),
            array_filter($rows, static fn(array $row): bool =>
                $row['kind'] === 'payment_return' && $row['status'] === 'posted' &&
                (int)(hsPayload($row['payload'])['originalPaymentId'] ?? 0) === $originalId)
        ));
        if ($originalAmount > 0 && (float)($payload['amount'] ?? 0) + $returned > $originalAmount + 0.01) {
            hsJson(['error' => 'قيمة مرتجع السداد تتجاوز قيمة السداد الأصلي'], 422);
        }
    }
    if (in_array($kind, ['purchase_return', 'stock_issue_return'], true)) {
        $originalId = (int)($payload['originalPurchaseId'] ?? $payload['originalStockIssueId'] ?? 0);
        $expectedKind = $kind === 'purchase_return' ? 'purchase' : 'stock_issue';
        if ($originalId <= 0) hsJson(['error' => 'يجب تحديد المستند الأصلي قبل تسجيل المرتجع'], 422);
        $originals = hsFindRecords($pdo, $expectedKind);
        if (!array_filter($originals, static fn(array $row): bool => (int)$row['id'] === $originalId && $row['status'] !== 'archived')) {
            hsJson(['error' => 'المستند الأصلي للمرتجع غير موجود أو مؤرشف'], 422);
        }
    }
    if (in_array($kind, ['salary_advance', 'salary_payment', 'commission'], true)) {
        $employeeId = (int)($payload['employeeRecordId'] ?? $payload['employeeId'] ?? 0);
        if ($employeeId <= 0 || !array_filter(hsFindRecords($pdo, 'employee'), static fn(array $row): bool => (int)$row['id'] === $employeeId && $row['status'] !== 'archived')) {
            hsJson(['error' => 'يجب ربط الحركة المالية بموظف رسمي'], 422);
        }
    }
    if (in_array($kind, ['stock_issue', 'stock_issue_return', 'purchase'], true)) {
        $warehouseId = (int)($payload['warehouseRecordId'] ?? $payload['warehouseId'] ?? 0);
        if ($warehouseId <= 0 || !array_filter(hsFindRecords($pdo, 'warehouse'), static fn(array $row): bool => (int)$row['id'] === $warehouseId && $row['status'] !== 'archived')) {
            hsJson(['error' => 'يجب ربط حركة المخزون بمستودع رسمي'], 422);
        }
    }
    if (in_array($kind, ['container', 'container_asset'], true)) {
        $code = hsAssetCode($payload);
        if ($code === '') hsJson(['error' => 'رقم أصل الحاوية مطلوب'], 422);
        foreach (hsFindRecords($pdo) as $row) {
            if ($row['id'] !== $ignoreId && in_array($row['kind'], ['container', 'container_asset'], true) && $row['status'] !== 'archived' && hsAssetCode(hsPayload($row['payload'])) === $code) {
                hsJson(['error' => 'رقم أصل الحاوية مستخدم مسبقًا'], 409);
            }
        }
    }
    if ($kind === 'contract') {
        $start = trim((string)($payload['startDate'] ?? ''));
        $end = trim((string)($payload['endDate'] ?? ''));
        if ($start && $end && strtotime($end) < strtotime($start)) hsJson(['error' => 'نهاية العقد يجب أن تكون بعد بدايته'], 422);
        $code = trim((string)($payload['containerCode'] ?? ''));
        if (in_array((string)($payload['status'] ?? 'active'), ['active', 'issued', 'scheduled', 'delivered'], true) && $code === '') {
            hsJson(['error' => 'العقد التشغيلي يجب أن يرتبط بحاوية'], 422);
        }
        if ($code && !hsFindAsset($pdo, $code)) hsJson(['error' => 'الحاوية المرتبطة بالعقد غير موجودة'], 422);
        $businessIdentifierError = hsContractBusinessIdentifierError($pdo, $payload);
        if ($businessIdentifierError !== null) hsJson(['error' => $businessIdentifierError], 422);
    }
    $numberFields = ['contract' => 'contractNumber', 'invoice' => 'invoiceNumber', 'receipt' => 'receiptNumber'];
    if (isset($numberFields[$kind])) {
        $field = $numberFields[$kind];
        $number = trim((string)($payload[$field] ?? ''));
        if ($number !== '') {
            foreach (hsFindRecords($pdo, $kind) as $row) {
                if ((int)$row['id'] !== $ignoreId && $row['status'] !== 'archived' && trim((string)(hsPayload($row['payload'])[$field] ?? $row['reference'])) === $number) {
                    hsJson(['error' => 'رقم المستند مستخدم مسبقًا'], 409);
                }
            }
        }
    }
    if ($kind === 'container_movement') {
        $code = trim((string)($payload['containerCode'] ?? ''));
        $type = trim((string)($payload['movementType'] ?? ''));
        $asset = hsFindAsset($pdo, $code);
        if ($code === '' || $type === '') hsJson(['error' => 'رقم الحاوية ونوع الحركة مطلوبان'], 422);
        if (!$asset) hsJson(['error' => 'الحاوية المرتبطة بالحركة غير موجودة'], 422);
        if (!hsMovementStatus($type)) hsJson(['error' => 'نوع حركة الحاوية غير مدعوم'], 422);
        if (!hsMovementAllowed((string)$asset['status'], $type)) hsJson(['error' => 'الحركة غير مسموحة للحالة الحالية للحاوية'], 422);
        foreach (['locationLat' => [-90, 90], 'locationLng' => [-180, 180]] as $key => $range) {
            if (($payload[$key] ?? '') !== '' && (!is_numeric($payload[$key]) || (float)$payload[$key] < $range[0] || (float)$payload[$key] > $range[1])) {
                hsJson(['error' => $key === 'locationLat' ? 'خط العرض غير صحيح' : 'خط الطول غير صحيح'], 422);
            }
        }
    }
}

function hsFinancialPostingInvariantIssue(PDO $pdo, string $kind, array $payload, int $currentRecordId): ?string {
    $rows = array_map('hsRecord', hsFindRecords($pdo));
    if ($kind === 'payment_return') {
        $originalId = (int)($payload['originalPaymentId'] ?? 0);
        $original = null;
        foreach ($rows as $row) {
            if ((int)$row['id'] === $originalId
                && in_array($row['kind'], ['payment', 'receipt'], true)
                && $row['status'] === 'posted') {
                $original = $row;
                break;
            }
        }
        if (!$original) return 'السداد الأصلي للمرتجع غير موجود أو غير مرحّل';
        $originalAmount = (float)($original['payload']['amount'] ?? 0);
        $returned = 0.0;
        foreach ($rows as $row) {
            if ((int)$row['id'] === $currentRecordId || $row['kind'] !== 'payment_return' || $row['status'] !== 'posted') continue;
            if ((int)($row['payload']['originalPaymentId'] ?? 0) === $originalId) {
                $returned += (float)($row['payload']['amount'] ?? $row['payload']['total'] ?? 0);
            }
        }
        if (is_finite($originalAmount)
            && $returned + (float)($payload['amount'] ?? $payload['total'] ?? 0) > $originalAmount + 0.01) {
            return 'قيمة مرتجع السداد تتجاوز قيمة السداد الأصلي';
        }
    }

    if ($kind === 'invoice_return') {
        $invoiceNumber = trim((string)($payload['invoiceNumber'] ?? $payload['originalInvoiceNumber'] ?? ''));
        $invoice = null;
        foreach ($rows as $row) {
            if ($row['kind'] !== 'invoice' || $row['status'] === 'archived') continue;
            if (trim((string)($row['payload']['invoiceNumber'] ?? $row['reference'] ?? '')) === $invoiceNumber) {
                $invoice = $row;
                break;
            }
        }
        if (!$invoice) return 'الفاتورة الأصلية للمرتجع غير موجودة';
        $invoiceTotal = (float)($invoice['payload']['total'] ?? $invoice['payload']['amount'] ?? 0);
        $returned = 0.0;
        foreach ($rows as $row) {
            if ((int)$row['id'] === $currentRecordId || $row['kind'] !== 'invoice_return' || $row['status'] !== 'posted') continue;
            $returnNumber = trim((string)($row['payload']['invoiceNumber'] ?? $row['payload']['originalInvoiceNumber'] ?? ''));
            if ($returnNumber === $invoiceNumber) {
                $returned += (float)($row['payload']['amount'] ?? $row['payload']['total'] ?? 0);
            }
        }
        if (is_finite($invoiceTotal)
            && $returned + (float)($payload['amount'] ?? $payload['total'] ?? 0) > $invoiceTotal + 0.01) {
            return 'قيمة المرتجع تتجاوز الرصيد المتبقي من الفاتورة';
        }
    }

    return null;
}

function hsAudit(PDO $pdo, int $recordId, string $kind, string $action, ?string $before, ?string $after, int $actorId): void {
    $stmt = $pdo->prepare("INSERT INTO container_system_audit (record_id, kind, action, before_payload, after_payload, actor_id, created_at) VALUES (:record_id, :kind, :action, :before_payload, :after_payload, :actor_id, :created_at)");
    $stmt->execute([
        ':record_id' => $recordId, ':kind' => $kind, ':action' => $action,
        ':before_payload' => $before, ':after_payload' => $after, ':actor_id' => $actorId,
        ':created_at' => date('c'),
    ]);
}

function hsSyncMovement(PDO $pdo, array $payload, int $actorId): void {
    $asset = hsFindAsset($pdo, (string)($payload['containerCode'] ?? ''));
    if (!$asset) throw new RuntimeException('الحاوية المرتبطة بالحركة غير موجودة');
    $nextStatus = hsMovementStatus((string)($payload['movementType'] ?? ''));
    if (!$nextStatus || !hsMovementAllowed((string)$asset['status'], (string)($payload['movementType'] ?? ''))) {
        throw new RuntimeException('الحركة غير مسموحة للحالة الحالية للحاوية');
    }
    $before = $asset['payload'];
    $next = hsPayload($before);
    $next['location'] = $payload['location'] ?? ($next['location'] ?? '');
    $next['lastMovementAt'] = date('c');
    $stmt = $pdo->prepare("UPDATE container_system_records SET status = :status, payload = :payload, updated_at = :updated_at WHERE id = :id");
    $stmt->execute([':status' => $nextStatus, ':payload' => json_encode($next, JSON_UNESCAPED_UNICODE), ':updated_at' => date('c'), ':id' => (int)$asset['id']]);
    hsAudit($pdo, (int)$asset['id'], (string)$asset['kind'], 'movement_sync', $before, json_encode($next, JSON_UNESCAPED_UNICODE), $actorId);
}

function hsContractOperationKind($value): string {
    $normalized = mb_strtolower(trim((string)$value));
    if (preg_match('/deliver|delivery|تسليم|إرسال|ارسال|إنزال|انزال|drop/u', $normalized)) return 'delivery';
    if (preg_match('/return|pickup|استرجاع|إرجاع|ارجاع|سحب|رفع/u', $normalized)) return 'return';
    return 'other';
}

function hsFindOpenContractOperation(array $records, array $requests, int $contractId, ?int $containerId = null, ?string $operationKind = null): ?array {
    $terminal = ['completed', 'cancelled', 'rejected', 'closed'];
    foreach ($requests as $request) {
        $status = mb_strtolower((string)($request['status'] ?? ''));
        $driverStatus = mb_strtolower((string)($request['driver_status'] ?? ''));
        $matchesContract = (int)($request['contract_record_id'] ?? 0) === $contractId;
        $matchesContainer = $containerId !== null && $containerId > 0
            && (int)($request['container_record_id'] ?? 0) === $containerId;
        if (in_array($status, $terminal, true) || in_array($driverStatus, $terminal, true)
            || (!$matchesContract && !$matchesContainer)) continue;
        $kind = hsContractOperationKind($request['service_type'] ?? '');
        if ($operationKind !== null && $kind !== $operationKind) continue;
        return [
            'id' => (int)($request['id'] ?? 0),
            'status' => (string)($request['driver_status'] ?? '') ?: (string)($request['status'] ?? ''),
            'assignedDriverId' => (int)($request['assigned_driver_id'] ?? 0),
        ];
    }

    foreach ($records as $record) {
        if (($record['kind'] ?? '') !== 'work_order' || ($record['status'] ?? '') === 'archived') continue;
        $payload = $record['payload'];
        $matchesContract = (int)($payload['contractRecordId'] ?? 0) === $contractId;
        $matchesContainer = $containerId !== null && $containerId > 0
            && (int)($payload['containerRecordId'] ?? 0) === $containerId;
        if (!$matchesContract && !$matchesContainer) continue;
        $kind = hsContractOperationKind($payload['serviceType'] ?? $payload['operationType'] ?? '');
        if ($operationKind !== null && $kind !== $operationKind) continue;
        $operationStatus = mb_strtolower((string)($payload['driverStatus'] ?? $payload['status'] ?? $record['status']));
        if (in_array($operationStatus, $terminal, true)
            || in_array(mb_strtolower((string)$record['status']), $terminal, true)) continue;
        return [
            'id' => (int)$record['id'],
            'status' => (string)($payload['driverStatus'] ?? $payload['status'] ?? $record['status']),
            'assignedDriverId' => (int)($payload['assignedDriverId'] ?? 0),
        ];
    }
    return null;
}

function hsUpdateContainerContractLifecycle(PDO $pdo, int $contractId, string $action, string $location, int $actorId, array $admin): array {
    if (!in_array($action, ['deliver', 'return', 'approve', 'reject', 'close'], true)) {
        throw new RuntimeException('إجراء دورة العقد غير مدعوم', 422);
    }
    $pdo->beginTransaction();
    try {
        $contractStmt = $pdo->prepare("SELECT * FROM container_system_records WHERE id = ? LIMIT 1");
        $contractStmt->execute([$contractId]);
        $contract = $contractStmt->fetch(PDO::FETCH_ASSOC);
        if (!$contract || $contract['kind'] !== 'contract' || $contract['status'] === 'archived') {
            throw new RuntimeException('العقد غير موجود أو مؤرشف', 404);
        }
        $contractPayload = hsPayload($contract['payload']);
        if ($action === 'deliver' && !in_array($contract['status'], ['active', 'approved', 'issued', 'scheduled'], true)) {
            throw new RuntimeException('لا يمكن تسليم العقد من حالته الحالية', 422);
        }
        if ($action === 'return' && $contract['status'] !== 'delivered') {
            throw new RuntimeException('لا يمكن استرجاع الحاوية قبل تسجيل تسليمها', 422);
        }
        if (in_array($action, ['approve', 'reject'], true)) {
            if (!in_array((string)($admin['role'] ?? ''), ['admin', 'manager'], true)) {
                throw new RuntimeException('اعتماد العقد متاح للمدير أو المدير الرئيسي فقط', 422);
            }
            if (!in_array($contract['status'], ['draft', 'pending_approval', 'issued'], true)) {
                throw new RuntimeException('لا يمكن اعتماد العقد من حالته الحالية', 422);
            }
            $now = date('c');
            $nextStatus = $action === 'approve' ? 'approved' : 'rejected';
            $nextPayload = array_merge($contractPayload, [
                'approvalStatus' => $nextStatus,
                $action === 'approve' ? 'approvedAt' : 'rejectedAt' => $now,
                $action === 'approve' ? 'approvedBy' : 'rejectedBy' => $actorId,
                'lifecycleAction' => $action,
            ]);
            $nextJson = json_encode($nextPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
            $pdo->prepare("UPDATE container_system_records SET status = ?, payload = ?, updated_at = ? WHERE id = ?")
                ->execute([$nextStatus, $nextJson, $now, $contractId]);
            hsAudit($pdo, $contractId, 'contract', 'contract_' . $action, (string)$contract['payload'], $nextJson, $actorId);
            $pdo->commit();
            $contractStmt->execute([$contractId]);
            return ['contract' => $contractStmt->fetch(PDO::FETCH_ASSOC), 'movement' => null, 'idempotent' => false];
        }

        $rawRecords = hsFindRecords($pdo);
        $records = array_map('hsRecord', $rawRecords);
        $requests = $pdo->query("SELECT * FROM service_requests")->fetchAll(PDO::FETCH_ASSOC);
        $containerId = (int)($contractPayload['containerRecordId'] ?? 0) ?: null;
        $openDelivery = hsFindOpenContractOperation($records, $requests, $contractId, $containerId, 'delivery');
        if ($action === 'deliver' && $openDelivery) {
            throw new RuntimeException("لا يمكن تسجيل التسليم؛ يوجد أمر إرسال قائم رقم {$openDelivery['id']}", 422);
        }
        if (in_array($action, ['return', 'close'], true)) {
            $openOperation = hsFindOpenContractOperation($records, $requests, $contractId, $containerId);
            if ($openOperation) {
                $assignment = !empty($openOperation['assignedDriverId']) ? 'ومسند' : 'غير مسند';
                throw new RuntimeException("لا يمكن تنفيذ الإجراء؛ يوجد أمر تشغيل {$openOperation['id']} حالته {$openOperation['status']} ومكلف بالسائق {$assignment}", 422);
            }
        }

        if ($action === 'close') {
            if ($contract['status'] !== 'returned') {
                throw new RuntimeException('لا يمكن إغلاق العقد قبل استرجاع الحاوية وتسجيل التفريغ أو الإكمال التشغيلي', 422);
            }
            $contractNumber = trim((string)($contractPayload['contractNumber'] ?? $contract['reference']));
            $collected = 0.0;
            foreach (hsPostedCollections($records) as $row) {
                $payload = $row['payload'];
                $matches = trim((string)($payload['contractNumber'] ?? '')) === $contractNumber
                    || (int)($payload['contractRecordId'] ?? $payload['contractId'] ?? 0) === $contractId;
                $allocation = null;
                if (is_array($payload['allocations'] ?? null)) {
                    foreach ($payload['allocations'] as $item) {
                        if (!is_array($item)) continue;
                        if ((int)($item['contractId'] ?? 0) === $contractId) {
                            $matches = true;
                            $allocation = $item;
                            break;
                        }
                    }
                }
                if ($matches) $collected += (float)($allocation['amount'] ?? $payload['amount'] ?? 0);
            }
            $returned = 0.0;
            foreach ($records as $row) {
                if ($row['kind'] !== 'payment_return' || $row['status'] !== 'posted') continue;
                $payload = $row['payload'];
                if ((int)($payload['contractRecordId'] ?? $payload['contractId'] ?? 0) === $contractId
                    || trim((string)($payload['contractNumber'] ?? '')) === $contractNumber) {
                    $returned += (float)($payload['amount'] ?? 0);
                }
            }
            $total = (float)($contractPayload['total'] ?? $contractPayload['amount'] ?? 0);
            $remaining = max($total - $collected + $returned, 0);
            if ($remaining > 0.01) {
                throw new RuntimeException('لا يمكن إغلاق العقد قبل اكتمال التسوية المالية؛ المتبقي ' . number_format($remaining, 2, '.', '') . ' ر.س', 422);
            }
            foreach ($records as $invoice) {
                if ($invoice['kind'] !== 'invoice' || $invoice['status'] === 'archived') continue;
                $invoicePayload = $invoice['payload'];
                if ((int)($invoicePayload['contractRecordId'] ?? 0) !== $contractId
                    && trim((string)($invoicePayload['contractNumber'] ?? '')) !== $contractNumber) continue;
                $invoiceTotal = (float)($invoicePayload['total'] ?? $invoicePayload['amount'] ?? 0);
                if (!is_finite($invoiceTotal) || $invoiceTotal <= 0.01) continue;
                $invoiceRemaining = (float)($invoicePayload['remaining'] ?? ($invoiceTotal - (float)($invoicePayload['paid'] ?? 0)));
                $postingStmt = $pdo->prepare("SELECT id FROM financial_transactions WHERE source_kind = 'invoice' AND source_id = ? AND status = 'posted' LIMIT 1");
                $postingStmt->execute([(int)$invoice['id']]);
                if ($invoice['status'] !== 'paid' || !is_finite($invoiceRemaining) || $invoiceRemaining > 0.01 || !$postingStmt->fetchColumn()) {
                    throw new RuntimeException('لا يمكن إغلاق العقد قبل ترحيل جميع فواتيره وتسويتها بالكامل', 422);
                }
            }

            $now = date('c');
            $nextPayload = array_merge($contractPayload, [
                'closedAt' => $now,
                'lifecycleAction' => 'close',
                'settlementStatus' => 'settled',
                'paid' => $collected - $returned,
                'remaining' => 0,
            ]);
            $nextJson = json_encode($nextPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
            $pdo->prepare("UPDATE container_system_records SET status = 'closed', payload = ?, updated_at = ? WHERE id = ?")
                ->execute([$nextJson, $now, $contractId]);
            foreach ($rawRecords as $row) {
                $payload = hsPayload($row['payload']);
                if ((int)($payload['contractRecordId'] ?? 0) !== $contractId) continue;
                if ($row['kind'] === 'contract_line' && $row['status'] !== 'archived') {
                    $linePayload = array_merge($payload, [
                        'status' => 'closed',
                        'lineLifecycleStatus' => 'closed',
                        'closedAt' => $now,
                        'lifecycleAction' => 'contract_close',
                    ]);
                    $lineJson = json_encode($linePayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
                    $pdo->prepare("UPDATE container_system_records SET status = 'closed', payload = ?, updated_at = ? WHERE id = ?")
                        ->execute([$lineJson, $now, (int)$row['id']]);
                    hsAudit($pdo, (int)$row['id'], 'contract_line', 'contract_close_line', (string)$row['payload'], $lineJson, $actorId);
                    continue;
                }
                if ($row['kind'] === 'container_assignment') {
                    $assignmentPayload = array_merge($payload, ['assignmentStatus' => 'closed', 'closedAt' => $now]);
                    $pdo->prepare("UPDATE container_system_records SET status = 'closed', payload = ?, updated_at = ? WHERE id = ?")
                        ->execute([json_encode($assignmentPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE), $now, (int)$row['id']]);
                }
            }
            if ($containerId !== null) {
                foreach ($rawRecords as $asset) {
                    if ((int)$asset['id'] !== $containerId || !in_array($asset['kind'], ['container', 'container_asset'], true)) continue;
                    $assetPayload = hsPayload($asset['payload']);
                    $nextAssetPayload = array_merge($assetPayload, [
                        'status' => 'available',
                        'assignmentRecordId' => null,
                        'assignedContractRecordId' => null,
                        'assignedSiteRecordId' => null,
                        'lastClosedContractId' => $contractId,
                        'lastClosedAt' => $now,
                    ]);
                    $assetJson = json_encode($nextAssetPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
                    $pdo->prepare("UPDATE container_system_records SET status = 'available', payload = ?, updated_at = ? WHERE id = ?")
                        ->execute([$assetJson, $now, $containerId]);
                    hsAudit($pdo, $containerId, (string)$asset['kind'], 'contract_close_asset_release', (string)$asset['payload'], $assetJson, $actorId);
                    break;
                }
            }
            hsAudit($pdo, $contractId, 'contract', 'contract_close', (string)$contract['payload'], $nextJson, $actorId);
            $pdo->commit();
            $contractStmt->execute([$contractId]);
            return ['contract' => $contractStmt->fetch(PDO::FETCH_ASSOC), 'movement' => null, 'idempotent' => false];
        }

        $lifecycleKey = $action === 'deliver' ? 'deliverAt' : 'returnAt';
        if (!empty($contractPayload[$lifecycleKey])) {
            $pdo->commit();
            return ['contract' => $contract, 'movement' => null, 'idempotent' => true];
        }
        $containerCode = trim((string)($contractPayload['containerCode'] ?? ''));
        if ($containerCode === '') throw new RuntimeException('العقد لا يحتوي على رقم حاوية', 422);
        $asset = null;
        foreach ($rawRecords as $candidate) {
            if (!in_array($candidate['kind'], ['container', 'container_asset'], true) || $candidate['status'] === 'archived') continue;
            $assetPayload = hsPayload($candidate['payload']);
            $code = trim((string)($assetPayload['assetCode'] ?? $assetPayload['code'] ?? $assetPayload['reference'] ?? ''));
            if ($code === $containerCode) { $asset = $candidate; break; }
        }
        if (!$asset) throw new RuntimeException('الحاوية المرتبطة بالعقد غير موجودة', 422);
        $requestStmt = $pdo->prepare("SELECT * FROM service_requests WHERE contract_record_id = ? LIMIT 1");
        $requestStmt->execute([$contractId]);
        $linkedRequest = $requestStmt->fetch(PDO::FETCH_ASSOC);
        if ($linkedRequest && (int)($linkedRequest['container_record_id'] ?? 0) !== (int)$asset['id']) {
            throw new RuntimeException('الطلب المرتبط لا يطابق أصل الحاوية في العقد', 422);
        }
        if (!hsMovementAllowed((string)$asset['status'], $action)) {
            throw new RuntimeException('لا يمكن تنفيذ ' . ($action === 'deliver' ? 'التسليم' : 'الاسترجاع') . ' على حاوية حالتها الحالية ' . $asset['status'], 422);
        }

        $now = date('c');
        $effectiveLocation = trim($location) !== '' ? trim($location) : trim((string)($contractPayload['location'] ?? ''));
        $nextContractPayload = array_merge($contractPayload, [
            $lifecycleKey => $now,
            'lifecycleAction' => $action,
            'atomicLifecycle' => true,
        ]);
        $nextContractStatus = $action === 'deliver' ? 'delivered' : 'returned';
        $nextAssetStatus = $action === 'deliver' ? 'rented' : 'available';
        $nextAssetPayload = array_merge(hsPayload($asset['payload']), [
            'status' => $nextAssetStatus,
            'lastMovementAt' => $now,
            'lastMovementContractId' => $contractId,
        ]);
        if ($effectiveLocation !== '') $nextAssetPayload['location'] = $effectiveLocation;
        $nextContractJson = json_encode($nextContractPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        $nextAssetJson = json_encode($nextAssetPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        $pdo->prepare("UPDATE container_system_records SET status = ?, payload = ?, updated_at = ? WHERE id = ?")
            ->execute([$nextContractStatus, $nextContractJson, $now, $contractId]);
        $pdo->prepare("UPDATE container_system_records SET status = ?, payload = ?, updated_at = ? WHERE id = ?")
            ->execute([$nextAssetStatus, $nextAssetJson, $now, (int)$asset['id']]);
        $movementKey = "contract-lifecycle-{$contractId}-{$action}";
        $movementPayload = [
            'operationKey' => $movementKey,
            'movementKey' => $movementKey,
            'contractRecordId' => $contractId,
            'contractNumber' => $contractPayload['contractNumber'] ?? $contract['reference'],
            'containerRecordId' => (int)$asset['id'],
            'containerCode' => $containerCode,
            'movementType' => $action,
            'movementDate' => $now,
            'location' => $effectiveLocation,
            'source' => 'contract_lifecycle',
            'operationalOnly' => false,
        ];
        $movementJson = json_encode($movementPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        $movementReference = "MOV-C{$contractId}-" . strtoupper($action);
        $movementStmt = $pdo->prepare("INSERT INTO container_system_records
            (kind, status, reference, payload, operation_key, created_by, created_at, updated_at)
            VALUES ('container_movement', 'posted', ?, ?, ?, ?, ?, ?)");
        $movementStmt->execute([$movementReference, $movementJson, $movementKey, $actorId, $now, $now]);
        $movementId = (int)$pdo->lastInsertId();
        hsAudit($pdo, $contractId, 'contract', 'atomic_' . $action, (string)$contract['payload'], $nextContractJson, $actorId);
        hsAudit($pdo, (int)$asset['id'], (string)$asset['kind'], 'atomic_' . $action, (string)$asset['payload'], $nextAssetJson, $actorId);
        hsAudit($pdo, $movementId, 'container_movement', 'create', null, $movementJson, $actorId);
        $pdo->commit();

        $contractStmt->execute([$contractId]);
        $movementQuery = $pdo->prepare("SELECT * FROM container_system_records WHERE id = ? LIMIT 1");
        $movementQuery->execute([$movementId]);
        return [
            'contract' => $contractStmt->fetch(PDO::FETCH_ASSOC),
            'movement' => $movementQuery->fetch(PDO::FETCH_ASSOC),
            'idempotent' => false,
        ];
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $error;
    }
}

function hostingerContainerSystemRoute(PDO $pdo, string $path, string $method, array $input): void {
    if (!str_starts_with($path, '/admin/container-system')) return;
    hsPrepareServiceRequestsTable($pdo);
    hsEnsureSchema($pdo);
    // Repair orders created before customer indexing was deployed. This keeps
    // Hostinger self-contained and makes the customer list an authoritative
    // projection of all historical service requests.
    hsSyncRequestsToCustomers($pdo);
    $admin = hsAuth($pdo);
    $actorId = (int)$admin['id'];

    if (preg_match('#^/admin/container-system/identity-review/(\d+)/resolve$#', $path, $matches) && $method === 'POST') {
        if (!hsCanManage($admin, 'customer') || !in_array((string)($admin['role'] ?? ''), ['admin', 'manager'], true)) {
            hsJson(['error' => 'مراجعة هوية العملاء متاحة للمدير أو المدير الرئيسي فقط'], 403);
        }
        $customerId = (int)$matches[1];
        $action = strtolower(trim((string)($input['action'] ?? '')));
        $reason = trim((string)($input['reason'] ?? ''));
        $targetCustomerId = (int)($input['targetCustomerId'] ?? 0);
        if ($customerId <= 0 || !in_array($action, ['approve', 'merge'], true) || strlen($reason) < 3) {
            hsJson(['error' => 'رقم الملف والإجراء وسبب المراجعة مطلوبة'], 422);
        }
        if ($action === 'merge' && ($targetCustomerId <= 0 || $targetCustomerId === $customerId)) {
            hsJson(['error' => 'اختر ملف عميل موثّقًا مختلفًا لدمج السجل فيه'], 422);
        }

        $now = date('c');
        try {
            $pdo->beginTransaction();
            $sourceStmt = $pdo->prepare("SELECT * FROM container_system_records WHERE id = ? LIMIT 1");
            $sourceStmt->execute([$customerId]);
            $source = $sourceStmt->fetch(PDO::FETCH_ASSOC);
            if (!$source || $source['kind'] !== 'customer' || $source['status'] === 'archived') {
                throw new RuntimeException('ملف العميل غير موجود');
            }
            $sourcePayload = hsPayload($source['payload']);
            if (($sourcePayload['identityReviewStatus'] ?? '') !== 'pending' || ($sourcePayload['identityVerification'] ?? '') !== 'unverified') {
                throw new RuntimeException('تمت مراجعة ملف العميل مسبقًا أو أنه غير مؤهل للمراجعة');
            }

            $updatedRequestCount = 0;
            $mergedIntoCustomerId = null;
            if ($action === 'approve') {
                $nextPayload = array_merge($sourcePayload, [
                    'identityVerification' => 'verified',
                    'identityReviewStatus' => 'approved',
                    'identityReviewedAt' => $now,
                    'identityReviewedBy' => $actorId,
                    'identityReviewReason' => $reason,
                ]);
            } else {
                $targetStmt = $pdo->prepare("SELECT * FROM container_system_records WHERE id = ? LIMIT 1");
                $targetStmt->execute([$targetCustomerId]);
                $target = $targetStmt->fetch(PDO::FETCH_ASSOC);
                if (!$target || $target['kind'] !== 'customer' || $target['status'] === 'archived') {
                    throw new RuntimeException('ملف العميل المستهدف غير موجود أو مؤرشف');
                }
                $targetPayload = hsPayload($target['payload']);
                if (($targetPayload['identityVerification'] ?? '') !== 'verified' || ($targetPayload['identityReviewStatus'] ?? '') === 'pending') {
                    throw new RuntimeException('لا يمكن الدمج إلا في ملف عميل سبق التحقق من هويته');
                }

                $rows = $pdo->query("SELECT id, kind, payload FROM container_system_records WHERE id NOT IN ({$customerId}, {$targetCustomerId})")->fetchAll(PDO::FETCH_ASSOC);
                $relink = $pdo->prepare("UPDATE container_system_records SET payload = :payload, updated_at = :updated_at WHERE id = :id");
                foreach ($rows as $row) {
                    $rowPayload = hsPayload($row['payload']);
                    if ((int)($rowPayload['customerRecordId'] ?? 0) !== $customerId) continue;
                    $nextRowPayload = $rowPayload;
                    $nextRowPayload['customerRecordId'] = $targetCustomerId;
                    $nextJson = json_encode($nextRowPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
                    $relink->execute([':payload' => $nextJson, ':updated_at' => $now, ':id' => (int)$row['id']]);
                    hsAudit($pdo, (int)$row['id'], (string)$row['kind'], 'identity_customer_merge_relink', (string)$row['payload'], (string)$nextJson, $actorId);
                }

                $requestStmt = $pdo->prepare("UPDATE service_requests SET customer_record_id = :target, updated_at = :updated_at WHERE customer_record_id = :source");
                $requestStmt->execute([':target' => $targetCustomerId, ':updated_at' => $now, ':source' => $customerId]);
                $updatedRequestCount = $requestStmt->rowCount();
                $mergedIntoCustomerId = $targetCustomerId;

                $mergedIds = is_array($targetPayload['mergedProvisionalCustomerIds'] ?? null)
                    ? array_values(array_unique(array_filter(array_map('intval', $targetPayload['mergedProvisionalCustomerIds']), static fn(int $id): bool => $id > 0)))
                    : [];
                $mergedIds[] = $customerId;
                $nextTargetPayload = array_merge($targetPayload, [
                    'mergedProvisionalCustomerIds' => array_values(array_unique($mergedIds)),
                    'identityMergeUpdatedAt' => $now,
                    'identityMergeUpdatedBy' => $actorId,
                ]);
                $nextTargetJson = json_encode($nextTargetPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
                $pdo->prepare("UPDATE container_system_records SET payload = ?, updated_at = ? WHERE id = ?")
                    ->execute([$nextTargetJson, $now, $targetCustomerId]);
                hsAudit($pdo, $targetCustomerId, 'customer', 'identity_review_merge_target', (string)$target['payload'], (string)$nextTargetJson, $actorId);

                $nextPayload = array_merge($sourcePayload, [
                    'identityVerification' => 'verified',
                    'identityReviewStatus' => 'merged',
                    'identityReviewedAt' => $now,
                    'identityReviewedBy' => $actorId,
                    'identityReviewReason' => $reason,
                    'mergedIntoCustomerId' => $targetCustomerId,
                    'mergedAt' => $now,
                    'mergedBy' => $actorId,
                ]);
            }

            $nextJson = json_encode($nextPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
            $nextStatus = $action === 'merge' ? 'archived' : (string)$source['status'];
            $pdo->prepare("UPDATE container_system_records SET status = ?, payload = ?, updated_at = ? WHERE id = ?")
                ->execute([$nextStatus, $nextJson, $now, $customerId]);
            hsAudit($pdo, $customerId, 'customer', $action === 'approve' ? 'identity_review_approved' : 'identity_review_merged', (string)$source['payload'], (string)$nextJson, $actorId);
            $pdo->commit();
        } catch (Throwable $error) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            $message = $error->getMessage();
            $status = str_contains($message, 'غير موجود') ? 404 : (str_contains($message, 'مسبقًا') || str_contains($message, 'موثّقًا') || str_contains($message, 'سبق التحقق') ? 409 : 422);
            hsJson(['error' => $message], $status);
        }

        $updatedStmt = $pdo->prepare("SELECT * FROM container_system_records WHERE id = ? LIMIT 1");
        $updatedStmt->execute([$customerId]);
        hsJson([
            'action' => $action,
            'customer' => hsRecord($updatedStmt->fetch(PDO::FETCH_ASSOC)),
            'updatedRequestCount' => $updatedRequestCount,
            'mergedIntoCustomerId' => $mergedIntoCustomerId,
        ]);
    }

    if (preg_match('#^/admin/container-system/contracts/(\d+)/lifecycle$#', $path, $matches) && $method === 'POST') {
        if (!hsCanManage($admin, 'contract')) {
            hsJson(['error' => 'ليس لديك صلاحية لتنفيذ دورة العقد'], 403);
        }
        $contractId = (int)$matches[1];
        $action = strtolower(trim((string)($input['action'] ?? '')));
        if ($contractId <= 0) hsJson(['error' => 'رقم العقد غير صحيح'], 400);
        if (!in_array($action, ['deliver', 'return', 'approve', 'reject', 'close'], true)) {
            hsJson(['error' => 'إجراء دورة العقد غير مدعوم'], 422);
        }
        try {
            $result = hsUpdateContainerContractLifecycle(
                $pdo,
                $contractId,
                $action,
                trim((string)($input['location'] ?? '')),
                $actorId,
                $admin,
            );
            hsJson([
                'contract' => hsRecord($result['contract']),
                'movement' => $result['movement'] ? hsRecord($result['movement']) : null,
                'idempotent' => (bool)$result['idempotent'],
            ], $result['idempotent'] ? 200 : 201);
        } catch (Throwable $error) {
            $status = in_array((int)$error->getCode(), [404, 409, 422], true) ? (int)$error->getCode() : 422;
            $message = $status === 422 || $status === 404
                ? $error->getMessage()
                : 'تعذر تنفيذ دورة العقد بشكل ذري';
            if (!in_array((int)$error->getCode(), [404, 409, 422], true)) {
                error_log('[container-system] contract lifecycle failed: ' . $error->getMessage());
                $message = 'تعذر تنفيذ دورة العقد بشكل ذري';
            }
            hsJson(['error' => $message], $status);
        }
    }

    if ($path === '/admin/container-system' && $method === 'GET') {
        $records = array_map('hsRecord', hsFindRecords($pdo));
        $organizationSettings = [];
        $settingStmt = $pdo->query("SELECT key, value FROM site_settings WHERE key IN (
            'company_name', 'company_name_en', 'company_logo', 'company_phone_call',
            'company_phone_whatsapp', 'company_email', 'company_address', 'company_city',
            'company_region', 'company_country', 'company_postal_code', 'company_tax_number'
        )");
        foreach ($settingStmt->fetchAll(PDO::FETCH_ASSOC) as $setting) {
            $organizationSettings[(string)$setting['key']] = (string)($setting['value'] ?? '');
        }
        $organization = [
            'name' => trim($organizationSettings['company_name'] ?? '') ?: trim($organizationSettings['company_name_en'] ?? ''),
            'companyName' => trim($organizationSettings['company_name'] ?? '') ?: trim($organizationSettings['company_name_en'] ?? ''),
            'englishName' => trim($organizationSettings['company_name_en'] ?? ''),
            'logo' => (string)($organizationSettings['company_logo'] ?? ''),
            'phone' => (string)($organizationSettings['company_phone_call'] ?? ''),
            'whatsapp' => (string)($organizationSettings['company_phone_whatsapp'] ?? ''),
            'email' => (string)($organizationSettings['company_email'] ?? ''),
            'address' => (string)($organizationSettings['company_address'] ?? ''),
            'city' => (string)($organizationSettings['company_city'] ?? ''),
            'region' => (string)($organizationSettings['company_region'] ?? ''),
            'country' => (string)($organizationSettings['company_country'] ?? ''),
            'postalCode' => (string)($organizationSettings['company_postal_code'] ?? ''),
            'taxNumber' => (string)($organizationSettings['company_tax_number'] ?? ''),
        ];
        $payments = [];
        foreach ($records as $record) {
            if (in_array($record['kind'], ['payment', 'receipt'], true)) {
                if (is_array($record['payload']['allocations'] ?? null)) {
                    foreach ($record['payload']['allocations'] as $allocation) {
                        $key = (string)($allocation['contractNumber'] ?? '');
                        if ($key) $payments[$key] = ($payments[$key] ?? 0) + (float)($allocation['amount'] ?? 0);
                    }
                } else {
                    $key = (string)($record['payload']['contractNumber'] ?? '');
                    if ($key) $payments[$key] = ($payments[$key] ?? 0) + (float)($record['payload']['amount'] ?? 0);
                }
            }
        }
        $contracts = [];
        foreach ($records as $record) {
            if ($record['kind'] !== 'contract') continue;
            $number = (string)($record['payload']['contractNumber'] ?? $record['reference']);
            $record['payload']['paid'] = $payments[$number] ?? 0;
            $record['payload']['remaining'] = max((float)($record['payload']['total'] ?? $record['payload']['amount'] ?? 0) - $record['payload']['paid'], 0);
            $contracts[] = $record;
        }
        $countKind = static fn(string $kind): int => count(array_filter($records, static fn(array $r): bool => $r['kind'] === $kind));
        $assets = array_filter($records, static fn(array $r): bool => in_array($r['kind'], ['container', 'container_asset'], true));
        $rented = count(array_filter($assets, static fn(array $r): bool => $r['status'] === 'rented'));
        $value = array_sum(array_map(static fn(array $r): float => (float)($r['payload']['total'] ?? 0), $contracts));
        $truth = hsFinancialTruth($pdo);
        $ledgerTotals = $truth['totals'];
        $collected = (float)($ledgerTotals['netCollections'] ?? 0);
        $expenses = (float)($ledgerTotals['expenses'] ?? 0);
        hsJson([
            'organization' => $organization,
            'summary' => [
                'customers' => $countKind('customer'), 'containers' => count($assets),
                'availableContainers' => count(array_filter($assets, static fn(array $r): bool => $r['status'] === 'available')),
                'rentedContainers' => $rented, 'activeContracts' => count(array_filter($contracts, static fn(array $r): bool => in_array($r['status'], ['active', 'issued', 'scheduled', 'delivered'], true))),
                'containerMovements' => $countKind('container_movement'), 'collected' => $collected,
                'contractValue' => (float)($ledgerTotals['grossRevenue'] ?? $value), 'debt' => (float)($ledgerTotals['receivables'] ?? 0), 'expenses' => $expenses,
                'financialTruth' => $truth,
                'maintenanceCost' => 0, 'vehicles' => $countKind('vehicle'), 'vehiclesReady' => count(array_filter($records, static fn(array $r): bool => $r['kind'] === 'vehicle' && $r['status'] === 'available')),
                'openLedgerEntries' => count(array_filter($records, static fn(array $r): bool => $r['kind'] === 'ledger_entry' && $r['status'] === 'open')),
                'expiringContracts' => 0, 'fleetUtilization' => 0,
                'containerUtilization' => count($assets) ? (int)round($rented / count($assets) * 100) : 0,
                'maintenanceDue' => 0,
            ],
            'records' => $records, 'expiringContracts' => [], 'recent' => array_slice($records, 0, 12),
        ]);
    }
    if ($path === '/admin/container-system/financial/core' && $method === 'GET') {
        if (!hsCanManage($admin, 'financial_reports')) hsJson(['error' => 'ليس لديك صلاحية للوصول إلى التقارير المالية'], 403);
        $from = isset($_GET['from']) && is_string($_GET['from']) ? $_GET['from'] : null;
        $to = isset($_GET['to']) && is_string($_GET['to']) ? $_GET['to'] : null;
        if (($from && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $from)) || ($to && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $to))) {
            hsJson(['error' => 'نطاق التاريخ المالي غير صالح'], 422);
        }
        hsJson(hsFinancialTruth($pdo, $from, $to));
    }
    if ($path === '/admin/container-system/financial/periods' && $method === 'GET') {
        hsFinancialTables($pdo);
        $periods = $pdo->query("SELECT * FROM financial_periods ORDER BY period_key DESC")->fetchAll(PDO::FETCH_ASSOC);
        hsJson($periods);
    }
    if (preg_match('#^/admin/container-system/financial/periods/(\d{4}-\d{2})/close$#', $path, $matches) && $method === 'POST') {
        hsFinancialTables($pdo);
        $periodKey = $matches[1];
        $periodStmt = $pdo->prepare("SELECT status FROM financial_periods WHERE period_key = ?");
        $periodStmt->execute([$periodKey]);
        if ($periodStmt->fetchColumn() === false) {
            $pdo->prepare("INSERT INTO financial_periods (period_key,starts_on,ends_on,status) VALUES (?,?,?,'open')")
                ->execute([$periodKey, "{$periodKey}-01", date('Y-m-t', strtotime("{$periodKey}-01"))]);
        }
        $pdo->prepare("UPDATE financial_periods SET status='closed', closed_by=?, closed_at=? WHERE period_key=?")
            ->execute([(int)$admin['id'], date('c'), $periodKey]);
        hsJson(['success' => true, 'periodKey' => $periodKey, 'status' => 'closed']);
    }
    if ($path === '/admin/container-system/financial/reconciliation' && $method === 'GET') {
        hsFinancialTables($pdo);
        $rows = $pdo->query("SELECT br.*, ft.transaction_number, ft.transaction_type
            FROM bank_reconciliations br
            LEFT JOIN financial_transactions ft ON ft.id = br.linked_transaction_id
            ORDER BY br.deposit_date DESC, br.id DESC")->fetchAll(PDO::FETCH_ASSOC);
        hsJson($rows);
    }
    if (preg_match('#^/admin/container-system/financial/reconciliation/(\d+)$#', $path, $matches) && $method === 'PATCH') {
        hsFinancialTables($pdo);
        $id = (int)$matches[1];
        $status = trim((string)($input['status'] ?? ''));
        $allowed = ['matched', 'partial', 'difference', 'unmatched', 'bank_fee', 'pending', 'approved', 'rejected', 'reversed'];
        if (!in_array($status, $allowed, true)) hsJson(['error' => 'حالة المطابقة البنكية غير مدعومة'], 422);
        $currentStmt = $pdo->prepare("SELECT * FROM bank_reconciliations WHERE id = ?");
        $currentStmt->execute([$id]);
        $current = $currentStmt->fetch(PDO::FETCH_ASSOC);
        if (!$current) hsJson(['error' => 'سجل المطابقة غير موجود'], 404);
        $reason = trim((string)($input['reason'] ?? ''));
        if (in_array($status, ['difference', 'bank_fee', 'rejected', 'reversed'], true) && strlen($reason) < 3) {
            hsJson(['error' => 'سبب الفرق أو الرفض مطلوب'], 422);
        }
        $trail = json_decode((string)($current['audit_trail'] ?? '[]'), true);
        if (!is_array($trail)) $trail = [];
        $trail[] = ['at' => date('c'), 'actorId' => (int)$admin['id'], 'from' => $current['status'], 'to' => $status, 'reason' => $reason];
        $pdo->prepare("UPDATE bank_reconciliations
            SET status=?, difference_reason=CASE WHEN ? <> '' THEN ? ELSE difference_reason END,
                rejection_reason=CASE WHEN ?='rejected' THEN ? ELSE rejection_reason END,
                reviewed_by=?, reviewed_at=?, audit_trail=? WHERE id=?")
            ->execute([$status, $reason, $reason, $status, $reason, (int)$admin['id'], date('c'), json_encode($trail, JSON_UNESCAPED_UNICODE), $id]);
        $bankFee = (float)($current['bank_fee'] ?? 0);
        if ($status === 'bank_fee' && $bankFee > 0) {
            hsPostFinancialCore($pdo, 'bank_fee', $id, [
                'amount' => $bankFee,
                'date' => date('Y-m-d'),
                'paymentMethod' => 'بنكي',
                'operationKey' => "bank-fee-reconciliation-{$id}",
            ], "BANK-FEE-{$id}", (int)$admin['id']);
        }
        $updatedStmt = $pdo->prepare("SELECT * FROM bank_reconciliations WHERE id = ?");
        $updatedStmt->execute([$id]);
        hsJson($updatedStmt->fetch(PDO::FETCH_ASSOC));
    }
    if ($path === '/admin/container-system/contracts/workflow' && $method === 'POST') {
        if (!hsCanManage($admin, 'contract')) hsJson(['error' => 'ليس لديك صلاحية لهذه العملية'], 403);
        $contract = is_array($input['contract'] ?? null) ? $input['contract'] : [];
        $assignment = is_array($input['assignment'] ?? null) ? $input['assignment'] : [];
        $appointment = is_array($input['appointment'] ?? null) ? $input['appointment'] : [];
        $service = is_array($input['serviceRequest'] ?? null) ? $input['serviceRequest'] : [];
        $contract = hsNormalizeFinancial('contract', $contract);
        $existingServiceRequestId = (int)($service['requestId'] ?? $contract['requestId'] ?? 0);
        if ($existingServiceRequestId > 0) {
            $contract['taxRate'] = 0;
            $contract['taxEnabled'] = true;
            $contract = hsNormalizeFinancial('contract', $contract);
        }
        $customerId = (int)($contract['customerRecordId'] ?? 0);
        $siteId = (int)($assignment['siteRecordId'] ?? $contract['siteRecordId'] ?? 0);
        $assetId = (int)($assignment['containerRecordId'] ?? $contract['containerRecordId'] ?? 0);
        if ($customerId <= 0 || $assetId <= 0) {
            hsJson(['error' => 'العميل وأصل الحاوية مطلوبان لإنشاء دورة العقد'], 422);
        }
        $operationKey = trim((string)($_SERVER['HTTP_IDEMPOTENCY_KEY'] ?? $input['operationKey'] ?? ''));
        if ($operationKey !== '' && (strlen($operationKey) < 8 || strlen($operationKey) > 160)) {
            hsJson(['error' => 'مفتاح العملية غير صالح'], 422);
        }
        if ($operationKey !== '') $contract['operationKey'] = $operationKey;
        if ($operationKey !== '') {
            $existingOperation = $pdo->prepare("SELECT * FROM container_system_records WHERE kind = 'contract' AND operation_key = :operation_key AND status <> 'archived' LIMIT 1");
            $existingOperation->execute([':operation_key' => $operationKey]);
            $existing = $existingOperation->fetch(PDO::FETCH_ASSOC);
            if ($existing) {
                $existingPayload = hsPayload($existing['payload']);
                $requestedNumber = trim((string)($contract['contractNumber'] ?? ''));
                $existingNumber = trim((string)($existingPayload['contractNumber'] ?? $existing['reference'] ?? ''));
                if ($requestedNumber !== '' && $existingNumber !== '' && $requestedNumber !== $existingNumber) {
                    hsJson(['error' => 'مفتاح العملية مستخدم لحمولة عقد مختلفة'], 409);
                }
                $allExisting = hsFindRecords($pdo);
                $related = static function (string $kind) use ($allExisting, $existing): ?array {
                    foreach ($allExisting as $row) {
                        if ($row['kind'] !== $kind || $row['status'] === 'archived') continue;
                        $payload = hsPayload($row['payload']);
                        if ((int)($payload['contractRecordId'] ?? 0) === (int)$existing['id']) return $row;
                    }
                    return null;
                };
                $serviceRequest = null;
                $serviceStmt = $pdo->prepare("SELECT * FROM service_requests WHERE contract_record_id = :contract_id LIMIT 1");
                $serviceStmt->execute([':contract_id' => (int)$existing['id']]);
                $serviceRequest = $serviceStmt->fetch(PDO::FETCH_ASSOC) ?: null;
                hsJson([
                    'contract' => hsRecord($existing),
                    'assignment' => ($row = $related('container_assignment')) ? hsRecord($row) : null,
                    'appointment' => ($row = $related('appointment')) ? hsRecord($row) : null,
                    'workOrder' => ($row = $related('work_order')) ? hsRecord($row) : null,
                    'serviceRequest' => $serviceRequest,
                    'idempotent' => true,
                ]);
            }
        }
        if ($existingServiceRequestId > 0) {
            $linkedServiceStmt = $pdo->prepare("SELECT contract_record_id FROM service_requests WHERE id = :id LIMIT 1");
            $linkedServiceStmt->execute([':id' => $existingServiceRequestId]);
            $linkedContractId = (int)($linkedServiceStmt->fetchColumn() ?: 0);
            if ($linkedContractId > 0) {
                $linkedContractStmt = $pdo->prepare("SELECT * FROM container_system_records WHERE id = :id AND kind = 'contract' AND status <> 'archived' LIMIT 1");
                $linkedContractStmt->execute([':id' => $linkedContractId]);
                $linkedContract = $linkedContractStmt->fetch(PDO::FETCH_ASSOC);
                if ($linkedContract) {
                    $allExisting = hsFindRecords($pdo);
                    $related = static function (string $kind) use ($allExisting, $linkedContract): ?array {
                        foreach ($allExisting as $row) {
                            if ($row['kind'] !== $kind || $row['status'] === 'archived') continue;
                            $payload = hsPayload($row['payload']);
                            if ((int)($payload['contractRecordId'] ?? 0) === (int)$linkedContract['id']) return $row;
                        }
                        return null;
                    };
                    $serviceStmt = $pdo->prepare("SELECT * FROM service_requests WHERE contract_record_id = :contract_id LIMIT 1");
                    $serviceStmt->execute([':contract_id' => $linkedContractId]);
                    hsJson([
                        'contract' => hsRecord($linkedContract),
                        'assignment' => ($row = $related('container_assignment')) ? hsRecord($row) : null,
                        'appointment' => ($row = $related('appointment')) ? hsRecord($row) : null,
                        'workOrder' => ($row = $related('work_order')) ? hsRecord($row) : null,
                        'serviceRequest' => $serviceStmt->fetch(PDO::FETCH_ASSOC) ?: null,
                        'idempotent' => true,
                    ]);
                }
            }
        }
        $find = static function (PDO $pdo, int $id): ?array {
            $stmt = $pdo->prepare("SELECT * FROM container_system_records WHERE id = :id LIMIT 1");
            $stmt->execute([':id' => $id]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            return $row ?: null;
        };
        $customer = $find($pdo, $customerId);
        $site = $siteId > 0 ? $find($pdo, $siteId) : null;
        $asset = $find($pdo, $assetId);
        if (!$customer || $customer['kind'] !== 'customer' || $customer['status'] === 'archived') hsJson(['error' => 'العميل غير موجود'], 422);
        if ($site && ($site['kind'] !== 'customer_site' || $site['status'] === 'archived')) hsJson(['error' => 'موقع العميل غير موجود'], 422);
        if ($site && (int)(hsPayload($site['payload'])['customerRecordId'] ?? 0) !== $customerId) hsJson(['error' => 'الموقع لا يتبع العميل المحدد'], 422);
        if (!$asset || !in_array($asset['kind'], ['container', 'container_asset'], true) || $asset['status'] === 'archived') hsJson(['error' => 'أصل الحاوية غير موجود'], 422);
        // The row status is the record lifecycle (commonly "active"); the
        // payload carries the asset's actual availability.
        $assetPayload = hsPayload($asset['payload']);
        hsApplyRequestContainerType($contract, $service, $assetPayload);
        $assetCategory = hsContractCategory($assetPayload);
        if ($assetCategory !== '') {
            $contract['category'] = $assetCategory;
            $contract['classification'] = $assetCategory;
        }
        $assetAvailability = hsCanonicalAssetStatus((string)($assetPayload['status'] ?? $asset['status']), (string)$asset['status']);
        if (!in_array($assetAvailability, ['available', 'reserved', 'active'], true)) hsJson(['error' => 'الحاوية ليست متاحة للتخصيص'], 422);
        // The wizard selects the asset by record id. Older bundles sometimes
        // omit containerCode, so derive it from the authoritative asset row
        // before validating the contract instead of rejecting a valid request.
        if (trim((string)($contract['containerCode'] ?? '')) === '') {
            $contract['containerCode'] = hsAssetCode($assetPayload);
        }
        $contract['siteRecordId'] = $siteId;
        $assignment['siteRecordId'] = $siteId;
        $customerPayloadForContract = hsPayload($customer['payload']);
        $commercialRegistration = trim((string)($contract['customerCommercialRegistration'] ?? $contract['commercialRegistration'] ?? ''));
        if ($commercialRegistration === '') {
            foreach (['commercialRegistration', 'commercialRegistrationNumber', 'crNumber', 'registrationNumber'] as $field) {
                $commercialRegistration = trim((string)($customerPayloadForContract[$field] ?? ''));
                if ($commercialRegistration !== '') break;
            }
        }
        $taxNumber = trim((string)($contract['customerTaxNumber'] ?? $contract['taxNumber'] ?? ''));
        if ($taxNumber === '') {
            foreach (['taxNumber', 'vatNumber', 'taxId'] as $field) {
                $taxNumber = trim((string)($customerPayloadForContract[$field] ?? ''));
                if ($taxNumber !== '') break;
            }
        }
        if ($commercialRegistration !== '') {
            $contract['customerCommercialRegistration'] = $commercialRegistration;
            $contract['commercialRegistration'] = $commercialRegistration;
        }
        if ($taxNumber !== '') {
            $contract['customerTaxNumber'] = $taxNumber;
            $contract['taxNumber'] = $taxNumber;
        }
        hsValidateRecord($pdo, 'contract', $contract);
        if (hsContractHasOverlappingDates($pdo, $contract)) {
            hsJson(['error' => 'الحاوية مرتبطة بعقد آخر خلال نفس الفترة'], 409);
        }
        $contractNumber = trim((string)($contract['contractNumber'] ?? ''));
        if ($contractNumber !== '') {
            $duplicateNumber = $pdo->prepare("SELECT id FROM container_system_records WHERE kind = 'contract' AND reference = :reference AND status <> 'archived' LIMIT 1");
            $duplicateNumber->execute([':reference' => $contractNumber]);
            if ($duplicateNumber->fetchColumn()) hsJson(['error' => 'رقم المستند مستخدم مسبقًا'], 409);
        }
        $now = date('c');
        try {
            $pdo->beginTransaction();
            $freshAsset = $find($pdo, $assetId);
            if (!$freshAsset || !in_array($freshAsset['kind'], ['container', 'container_asset'], true) || $freshAsset['status'] === 'archived') {
                throw new RuntimeException('أصل الحاوية غير موجود', 422);
            }
            $assetPayload = hsPayload($freshAsset['payload']);
            $assetAvailability = hsCanonicalAssetStatus((string)($assetPayload['status'] ?? $freshAsset['status']), (string)$freshAsset['status']);
            if (!in_array($assetAvailability, ['available', 'reserved', 'active'], true)) {
                throw new RuntimeException('الحاوية ليست متاحة للتخصيص', 409);
            }
            if (hsHasActiveContainerAssignment($pdo, $assetId)) {
                throw new RuntimeException('الحاوية مرتبطة بتخصيص نشط بالفعل', 409);
            }
            if (hsContractHasOverlappingDates($pdo, $contract)) {
                throw new RuntimeException('الحاوية مرتبطة بعقد آخر خلال نفس الفترة', 409);
            }
            $asset = $freshAsset;
            if (!$site) {
                $location = trim((string)($contract['location'] ?? ''));
                if ($location === '') throw new RuntimeException('موقع العقد مطلوب');
                $sitePayload = [
                    'customerRecordId' => $customerId,
                    'name' => $location,
                    'address' => $location,
                    'location' => $location,
                    'locationCoordinates' => (string)($contract['locationCoordinates'] ?? ''),
                    'locationMode' => (string)($contract['locationMode'] ?? 'manual'),
                    'propertyNumber' => (string)($contract['propertyNumber'] ?? ''),
                    'planNumber' => (string)($contract['planNumber'] ?? ''),
                ];
                $siteInsert = $pdo->prepare("INSERT INTO container_system_records (kind, status, reference, payload, operation_key, created_by, created_at, updated_at) VALUES ('customer_site', 'active', '', :payload, NULL, :created_by, :created_at, :updated_at)");
                $siteInsert->execute([
                    ':payload' => json_encode($sitePayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE),
                    ':created_by' => $actorId,
                    ':created_at' => $now,
                    ':updated_at' => $now,
                ]);
                $siteId = (int)$pdo->lastInsertId();
                $pdo->prepare("UPDATE container_system_records SET reference = :reference WHERE id = :id")
                    ->execute([':reference' => 'SITE-' . str_pad((string)$siteId, 5, '0', STR_PAD_LEFT), ':id' => $siteId]);
                $site = $find($pdo, $siteId);
            }
            $insert = $pdo->prepare("INSERT INTO container_system_records (kind, status, reference, payload, operation_key, created_by, created_at, updated_at) VALUES (:kind, :status, '', :payload, :operation_key, :created_by, :created_at, :updated_at)");
            $insert->execute([':kind' => 'contract', ':status' => 'active', ':payload' => json_encode($contract, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE), ':operation_key' => $operationKey !== '' ? $operationKey : null, ':created_by' => $actorId, ':created_at' => $now, ':updated_at' => $now]);
            $contractId = (int)$pdo->lastInsertId();
            $contractNumber = trim((string)($contract['contractNumber'] ?? ''));
            if ($contractNumber === '') $contractNumber = 'RNT-' . str_pad((string)$contractId, 5, '0', STR_PAD_LEFT);
            $contract['contractNumber'] = $contractNumber;
            $pdo->prepare("UPDATE container_system_records SET reference = :reference, payload = :payload WHERE id = :id")->execute([':reference' => $contractNumber, ':payload' => json_encode($contract, JSON_UNESCAPED_UNICODE), ':id' => $contractId]);
            $assignment['contractRecordId'] = $contractId; $assignment['contractNumber'] = $contractNumber; $assignment['siteRecordId'] = $siteId; $assignment['containerRecordId'] = $assetId; $assignment['assignmentStatus'] = $assignment['assignmentStatus'] ?? 'reserved';
            $insert->execute([':kind' => 'container_assignment', ':status' => 'reserved', ':payload' => json_encode($assignment, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE), ':operation_key' => null, ':created_by' => $actorId, ':created_at' => $now, ':updated_at' => $now]);
            $assignmentId = (int)$pdo->lastInsertId();
            $pdo->prepare("UPDATE container_system_records SET reference = :reference WHERE id = :id")->execute([':reference' => 'ASSIGN-' . $assignmentId, ':id' => $assignmentId]);
            $assetPayload['assignmentRecordId'] = $assignmentId; $assetPayload['assignedContractRecordId'] = $contractId; $assetPayload['assignedSiteRecordId'] = $siteId;
            $pdo->prepare("UPDATE container_system_records SET status = 'reserved', payload = :payload, updated_at = :updated_at WHERE id = :id")->execute([':payload' => json_encode($assetPayload, JSON_UNESCAPED_UNICODE), ':updated_at' => $now, ':id' => $assetId]);
            $customerPayload = hsPayload($customer['payload']);
            // Hostinger databases may have service_requests timestamps without
            // a SQLite default. Always provide both values explicitly so the
            // workflow remains valid across old and new schemas.
            if ($existingServiceRequestId > 0) {
                $existingServiceStmt = $pdo->prepare("SELECT id, status, contract_record_id FROM service_requests WHERE id = :id LIMIT 1");
                $existingServiceStmt->execute([':id' => $existingServiceRequestId]);
                $existingService = $existingServiceStmt->fetch(PDO::FETCH_ASSOC);
                if (!$existingService) throw new RuntimeException('طلب الخدمة المرتبط غير موجود');
                if (!empty($existingService['contract_record_id']) && (int)$existingService['contract_record_id'] !== $contractId) {
                    throw new RuntimeException('طلب الخدمة مرتبط بعقد آخر بالفعل');
                }
                $serviceStatus = (string)($existingService['status'] ?? 'pending');
                if ($serviceStatus === 'pending') $serviceStatus = 'in_progress';
                $pdo->prepare("UPDATE service_requests SET status = :status, customer_record_id = :customer_record_id, container_record_id = :container_record_id, contract_record_id = :contract_record_id, updated_at = :updated_at WHERE id = :id")
                    ->execute([':status' => $serviceStatus, ':customer_record_id' => $customerId, ':container_record_id' => $assetId, ':contract_record_id' => $contractId, ':updated_at' => $now, ':id' => $existingServiceRequestId]);
                $serviceId = $existingServiceRequestId;
            } else {
                $serviceId = null;
            }
            $appointmentType = strtolower(trim((string)($appointment['appointmentType'] ?? 'delivery')));
            $operationType = in_array($appointmentType, ['pickup', 'return', 'استرجاع', 'استلام'], true)
                ? 'PICKUP_CONTAINER'
                : 'DELIVER_CONTAINER';
            $workOrderOperationKey = $operationKey !== ''
                ? $operationKey . ':work-order'
                : 'contract-' . $contractId . '-delivery';
            $scheduledAt = trim((string)($service['scheduledAt'] ?? $appointment['scheduledAt'] ?? ''));
            if ($scheduledAt === '' && !empty($appointment['appointmentDate'])) {
                $scheduledAt = (string)$appointment['appointmentDate'] . 'T' . (string)($appointment['appointmentTime'] ?? '00:00') . ':00';
            }
            $workOrderPayload = [
                'operationKey' => $workOrderOperationKey,
                'workOrderNumber' => 'WO-' . str_pad((string)$contractId, 6, '0', STR_PAD_LEFT),
                'contractNumber' => $contractNumber,
                'customerRecordId' => $customerId,
                'contractRecordId' => $contractId,
                'contractRecordIds' => [$contractId],
                'containerRecordId' => $assetId,
                'containerRecordIds' => [$assetId],
                'containerCodes' => [(string)($contract['containerCode'] ?? hsAssetCode($assetPayload))],
                'siteRecordId' => $siteId,
                'customerName' => (string)($service['clientName'] ?? $customerPayload['name'] ?? $customerPayload['customerName'] ?? ''),
                'phone' => (string)($service['phone'] ?? $customerPayload['phone'] ?? ''),
                'email' => (string)($service['email'] ?? $customerPayload['email'] ?? ''),
                'operationType' => $operationType,
                'legacyRequestId' => $existingServiceRequestId > 0 ? $existingServiceRequestId : null,
                'serviceType' => (string)($service['serviceType'] ?? ($operationType === 'PICKUP_CONTAINER' ? 'استرجاع حاوية' : 'تسليم حاوية')),
                'containerCode' => (string)($contract['containerCode'] ?? hsAssetCode($assetPayload)),
                'location' => (string)($service['location'] ?? $contract['location'] ?? 'يحدد لاحقًا'),
                'notes' => (string)($service['notes'] ?? $contract['notes'] ?? ''),
                'appointmentRecordId' => null,
                'appointmentType' => (string)($appointment['appointmentType'] ?? 'scheduled'),
                'appointmentDate' => (string)($appointment['appointmentDate'] ?? ''),
                'appointmentTime' => (string)($appointment['appointmentTime'] ?? ''),
                'scheduledAt' => $scheduledAt,
                'assignedDriverId' => null,
                'assignedVehicleId' => null,
                'driverStatus' => 'unassigned',
                'status' => 'new',
                'source' => 'contract_workflow',
            ];
            $insert->execute([
                ':kind' => 'work_order',
                ':status' => 'new',
                ':payload' => json_encode($workOrderPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE),
                ':operation_key' => $workOrderOperationKey,
                ':created_by' => $actorId,
                ':created_at' => $now,
                ':updated_at' => $now,
            ]);
            $workOrderId = (int)$pdo->lastInsertId();
            $pdo->prepare("UPDATE container_system_records SET reference = :reference WHERE id = :id")
                ->execute([':reference' => $workOrderPayload['workOrderNumber'], ':id' => $workOrderId]);
            $invoiceRow = null;
            $billingEnabled = !in_array(strtolower(trim((string)($contract['billingEnabled'] ?? 'true'))), ['false', '0', 'no'], true);
            $contractValue = (float)($contract['total'] ?? $contract['amount'] ?? 0);
            if ($billingEnabled && $contractValue > 0) {
                $allRows = hsFindRecords($pdo);
                $billingPeriod = substr((string)($contract['billingPeriod'] ?? $contract['startDate'] ?? $now), 0, 7);
                $invoiceOperationKey = "contract-{$contractId}-period-{$billingPeriod}";
                $existingInvoice = array_values(array_filter($allRows, static function (array $row) use ($contractId, $billingPeriod): bool {
                    if ($row['kind'] !== 'invoice' || $row['status'] === 'archived') return false;
                    $payload = hsPayload($row['payload']);
                    return (int)($payload['contractRecordId'] ?? 0) === $contractId &&
                        (string)($payload['billingPeriod'] ?? '') === $billingPeriod;
                }));
                if (!$existingInvoice) {
                    $containerCode = trim((string)($contract['containerCode'] ?? hsAssetCode($assetPayload)));
                    $containerType = trim((string)($contract['containerType'] ?? $assetPayload['typeName'] ?? $assetPayload['containerType'] ?? $assetPayload['size'] ?? ''));
                    $contractLocation = trim((string)($contract['location'] ?? hsPayload($site['payload'])['address'] ?? ''));
                    $subtotal = (float)($contract['amount'] ?? 0);
                    $taxRate = (float)($contract['taxRate'] ?? 15);
                    $taxEnabled = ($contract['taxEnabled'] ?? false) === true || in_array(strtolower((string)($contract['taxEnabled'] ?? '')), ['true', '1', 'yes', 'نعم'], true);
                    $taxAmount = $taxEnabled ? (float)($contract['taxAmount'] ?? round($subtotal * $taxRate / 100, 2)) : 0;
                    $total = $taxEnabled ? (float)($contract['total'] ?? round($subtotal + $taxAmount, 2)) : $subtotal;
                    $lineDescription = $containerType !== '' ? "حاوية {$containerCode} — {$containerType}" : "حاوية {$containerCode}";
                    $lineItem = ['description' => $lineDescription, 'containerCode' => $containerCode, 'quantity' => 1, 'unitPrice' => $subtotal, 'amount' => $subtotal, 'taxRate' => $taxRate, 'taxEnabled' => $taxEnabled, 'taxAmount' => $taxAmount, 'total' => $total, 'location' => $contractLocation];
                    $invoicePayload = [
                        'invoiceType' => 'standard', 'invoiceStatus' => 'due', 'lifecycleStatus' => 'due', 'paymentStatus' => 'unpaid',
                        'source' => 'contract_billing', 'contractRecordId' => $contractId, 'contractNumber' => $contractNumber,
                        'customerRecordId' => $customerId, 'customerName' => (string)($customerPayload['name'] ?? $customerPayload['customerName'] ?? ''),
                        'customerPhone' => (string)($customerPayload['phone'] ?? $customerPayload['mobile'] ?? ''),
                        'customerTaxNumber' => (string)($customerPayload['taxNumber'] ?? $customerPayload['vatNumber'] ?? ''),
                        'customerAddress' => (string)($customerPayload['address'] ?? $customerPayload['location'] ?? ''),
                        'serviceAddress' => $contractLocation, 'location' => $contractLocation, 'siteRecordId' => $siteId, 'containerRecordId' => $assetId,
                        'containerCode' => $containerCode, 'containerType' => $containerType, 'billingPeriod' => $billingPeriod,
                        'billingFrequency' => (string)($contract['billingFrequency'] ?? 'monthly'), 'startDate' => $contract['startDate'] ?? $billingPeriod,
                        'endDate' => $contract['endDate'] ?? $billingPeriod, 'amount' => $subtotal, 'subtotal' => $subtotal,
                        'taxRate' => $taxRate, 'taxEnabled' => $taxEnabled, 'taxAmount' => $taxAmount, 'total' => $total, 'paid' => 0, 'remaining' => $total,
                        'operationKey' => $invoiceOperationKey, 'date' => substr((string)($contract['issueDate'] ?? $now), 0, 10),
                        'description' => $lineDescription, 'quantity' => 1, 'unitPrice' => $subtotal, 'lineItems' => [$lineItem],
                        'contractTerms' => is_array($contract['contractTerms'] ?? null) ? $contract['contractTerms'] : [],
                    ];
                    $invoiceInsert = $pdo->prepare("INSERT INTO container_system_records (kind, status, reference, payload, operation_key, created_by, created_at, updated_at) VALUES ('invoice', 'due', '', :payload, :operation_key, :created_by, :created_at, :updated_at)");
                    $invoiceInsert->execute([':payload' => json_encode($invoicePayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE), ':operation_key' => $invoiceOperationKey, ':created_by' => $actorId, ':created_at' => $now, ':updated_at' => $now]);
                    $invoiceId = (int)$pdo->lastInsertId();
                    $invoiceNumber = 'INV-' . str_pad((string)$invoiceId, 5, '0', STR_PAD_LEFT);
                    $invoicePayload['invoiceNumber'] = $invoiceNumber;
                    $invoicePayload['qrCodeData'] = json_encode(['invoiceNumber' => $invoiceNumber, 'recordId' => $invoiceId, 'total' => $total, 'date' => $invoicePayload['date']], JSON_UNESCAPED_UNICODE);
                    $pdo->prepare("UPDATE container_system_records SET reference = :reference, payload = :payload, updated_at = :updated_at WHERE id = :id")->execute([':reference' => $invoiceNumber, ':payload' => json_encode($invoicePayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE), ':updated_at' => $now, ':id' => $invoiceId]);
                    $invoiceRow = $find($pdo, $invoiceId);
                } else {
                    $invoiceRow = $existingInvoice[0];
                }
                if ($invoiceRow) {
                    $invoicePayloadForPosting = hsPayload($invoiceRow['payload'] ?? null);
                    $invoiceTotalForPosting = (float)($invoicePayloadForPosting['total'] ?? $invoicePayloadForPosting['amount'] ?? 0);
                    if ($invoiceTotalForPosting > 0) {
                        $postingCheck = $pdo->prepare("SELECT id FROM financial_transactions WHERE source_kind = 'invoice' AND source_id = ? AND status = 'posted' LIMIT 1");
                        $postingCheck->execute([(int)$invoiceRow['id']]);
                        if (!$postingCheck->fetchColumn()) {
                            $invoicePayloadForPosting['invoiceStatus'] = 'due';
                            $invoicePayloadForPosting['lifecycleStatus'] = 'due';
                            $invoicePayloadForPosting['paymentStatus'] = (float)($invoicePayloadForPosting['paid'] ?? 0) > 0 ? 'partially_paid' : 'unpaid';
                            $invoicePayloadForPosting['amount'] = (float)($invoicePayloadForPosting['amount'] ?? $invoiceTotalForPosting);
                            $pdo->prepare("UPDATE container_system_records SET status='due',payload=:payload,updated_at=:updated_at WHERE id=:id")
                                ->execute([':payload' => json_encode($invoicePayloadForPosting, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE), ':updated_at' => $now, ':id' => (int)$invoiceRow['id']]);
                            $postingPayload = $invoicePayloadForPosting;
                            $postingPayload['amount'] = $invoiceTotalForPosting;
                            hsPostFinancialCore($pdo, 'invoice', (int)$invoiceRow['id'], $postingPayload, (string)($invoiceRow['reference'] ?? ''), $actorId);
                            $invoiceRow = $find($pdo, (int)$invoiceRow['id']);
                        }
                    }
                }
            }
            $pdo->commit();
            $contractRow = $find($pdo, $contractId);
            $assignmentRow = $find($pdo, $assignmentId);
            $workOrderRow = $find($pdo, $workOrderId);
            hsJson([
                'contract' => hsRecord($contractRow),
                'assignment' => hsRecord($assignmentRow),
                'appointment' => null,
                'workOrder' => hsRecord($workOrderRow),
                'serviceRequest' => $serviceId ? ['id' => $serviceId] : null,
                'invoice' => $invoiceRow ? hsRecord($invoiceRow) : null,
                'idempotent' => false,
            ], 201);
        } catch (Throwable $error) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            error_log('[container-system] contract workflow failed: ' . $error->getMessage());
            if ((int)$error->getCode() === 409) hsJson(['error' => $error->getMessage()], 409);
            hsJson(['error' => 'تعذر إنشاء دورة العقد كاملة'], 422);
        }
    }
    if ($path === '/admin/container-system/financial/contract-ledgers' && $method === 'GET') {
        $contractId = (int)($_GET['contractId'] ?? 0);
        $search = mb_strtolower(trim((string)($_GET['search'] ?? '')));
        $rows = array_map('hsRecord', hsFindRecords($pdo));
        $contracts = array_filter($rows, static fn(array $row): bool => $row['kind'] === 'contract' && (!$contractId || (int)$row['id'] === $contractId));
        $payments = hsPostedCollections($rows);
        $returns = array_filter($rows, static fn(array $row): bool => $row['kind'] === 'payment_return' && $row['status'] === 'posted');
        $deposits = array_filter($rows, static fn(array $row): bool => in_array($row['kind'], ['deposit', 'bank_deposit'], true) && $row['status'] === 'posted');
        $ledgers = [];
        foreach ($contracts as $contract) {
            $payload = $contract['payload']; $number = (string)($payload['contractNumber'] ?? $contract['reference']);
            $relatedPayments = array_values(array_filter($payments, static function (array $row) use ($contract, $number): bool {
                if ((string)($row['payload']['contractNumber'] ?? '') === $number
                    || (int)($row['payload']['contractRecordId'] ?? $row['payload']['contractId'] ?? 0) === (int)$contract['id']) return true;
                foreach (($row['payload']['allocations'] ?? []) as $allocation) {
                    if ((int)($allocation['contractId'] ?? 0) === (int)$contract['id']) return true;
                }
                return false;
            }));
            $relatedReturns = array_values(array_filter($returns, static function (array $row) use ($contract, $number, $rows): bool {
                $payload = $row['payload'];
                if ((string)($payload['contractNumber'] ?? '') === $number
                    || (int)($payload['contractRecordId'] ?? $payload['contractId'] ?? 0) === (int)$contract['id']) return true;
                $invoiceId = (int)($payload['originalInvoiceId'] ?? $payload['invoiceRecordId'] ?? 0);
                if ($invoiceId <= 0) return false;
                foreach ($rows as $invoice) {
                    if ($invoice['kind'] !== 'invoice' || (int)$invoice['id'] !== $invoiceId) continue;
                    $invoicePayload = $invoice['payload'];
                    return (int)($invoicePayload['contractRecordId'] ?? 0) === (int)$contract['id']
                        || (string)($invoicePayload['contractNumber'] ?? '') === $number;
                }
                return false;
            }));
            $relatedDeposits = array_values(array_filter($deposits, static function (array $row) use ($relatedPayments, $contract, $number): bool {
                $payload = $row['payload'];
                if ((string)($payload['contractNumber'] ?? '') === $number || (int)($payload['linkedContractId'] ?? 0) === (int)$contract['id']) return true;
                foreach ($relatedPayments as $payment) {
                    if ((int)($payload['sourcePaymentId'] ?? $payload['linkedPaymentId'] ?? 0) === (int)$payment['id']) return true;
                }
                return false;
            }));
            $total = (float)($payload['total'] ?? $payload['amount'] ?? 0); $collected = array_sum(array_map(static fn(array $row): float => (float)($row['payload']['amount'] ?? 0), $relatedPayments));
            $collected = array_sum(array_map(static function (array $row) use ($contract): float {
                foreach (($row['payload']['allocations'] ?? []) as $allocation) {
                    if ((int)($allocation['contractId'] ?? 0) === (int)$contract['id']) return (float)($allocation['amount'] ?? 0);
                }
                return (float)($row['payload']['amount'] ?? 0);
            }, $relatedPayments));
            $collected -= array_sum(array_map(static fn(array $row): float => (float)($row['payload']['amount'] ?? $row['payload']['total'] ?? 0), $relatedReturns));
            if ($search !== '' && !str_contains(mb_strtolower($number . ' ' . json_encode($payload, JSON_UNESCAPED_UNICODE)), $search)) continue;
            $deposited = array_sum(array_map(static fn(array $row): float => (float)($row['payload']['amount'] ?? $row['payload']['total'] ?? 0), $relatedDeposits));
            $ledgers[] = ['contract' => $contract, 'total' => $total, 'collected' => $collected, 'deposited' => $deposited, 'remaining' => max($total - $collected, 0), 'deposits' => $relatedDeposits, 'payments' => $relatedPayments];
        }
        hsJson(['ledgers' => $ledgers, 'totals' => ['contractValue' => array_sum(array_column($ledgers, 'total')), 'collected' => array_sum(array_column($ledgers, 'collected')), 'deposited' => array_sum(array_column($ledgers, 'deposited')), 'remaining' => array_sum(array_column($ledgers, 'remaining'))]]);
    }
    if ($path === '/admin/container-system/financial/settle' && $method === 'POST') {
        if (!hsCanManage($admin, 'payment')) hsJson(['error' => 'ليس لديك صلاحية تسجيل تحصيل العقود'], 403);
        $amount = (float)($input['amount'] ?? 0);
        $methodName = trim((string)($input['paymentMethod'] ?? ''));
        $operationKey = trim((string)($_SERVER['HTTP_IDEMPOTENCY_KEY'] ?? $input['operationKey'] ?? ''));
        $rows = array_map('hsRecord', hsFindRecords($pdo));
        $requestedInvoiceId = (int)($input['invoiceId'] ?? $input['invoiceRecordId'] ?? 0);
        $requestedInvoice = null;
        foreach ($rows as $row) {
            if ($row['kind'] !== 'invoice' || $row['status'] === 'archived') continue;
            $invoiceNumber = trim((string)($row['payload']['invoiceNumber'] ?? $row['reference'] ?? ''));
            if (($requestedInvoiceId > 0 && (int)$row['id'] === $requestedInvoiceId)
                || ($requestedInvoiceId <= 0 && trim((string)($input['invoiceNumber'] ?? '')) !== ''
                    && $invoiceNumber === trim((string)$input['invoiceNumber']))) {
                $requestedInvoice = $row;
                break;
            }
        }
        $requestedInvoicePayload = $requestedInvoice['payload'] ?? [];
        $requestedContractId = (int)($input['contractId'] ?? $requestedInvoicePayload['contractRecordId'] ?? 0);
        if ($requestedContractId <= 0 && $requestedInvoice) {
            $requestedContractNumber = trim((string)($requestedInvoicePayload['contractNumber'] ?? ''));
            foreach ($rows as $row) {
                if ($row['kind'] !== 'contract' || $row['status'] === 'archived') continue;
                $contractPayload = $row['payload'] ?? [];
                if ((int)($requestedInvoicePayload['contractRecordId'] ?? 0) === (int)$row['id']
                    || ($requestedContractNumber !== '' && trim((string)($contractPayload['contractNumber'] ?? $row['reference'] ?? '')) === $requestedContractNumber)) {
                    $requestedContractId = (int)$row['id'];
                    break;
                }
            }
        }
        $requested = is_array($input['allocations'] ?? null) && count($input['allocations']) > 0
            ? $input['allocations']
            : ($requestedContractId > 0 ? [['contractId' => $requestedContractId, 'amount' => $amount, 'invoiceId' => $requestedInvoice['id'] ?? $input['invoiceId'] ?? $input['invoiceRecordId'] ?? null]] : []);
        if ($amount <= 0 || $methodName === '' || strlen($operationKey) < 8 || strlen($operationKey) > 160 || count($requested) === 0) hsJson(['error' => 'بيانات التحصيل أو التوزيع غير صحيحة'], 422);
        $allocations = array_map(static fn(array $item): array => ['contractId' => (int)($item['contractId'] ?? 0), 'amount' => (float)($item['amount'] ?? 0), 'invoiceId' => isset($item['invoiceId']) && $item['invoiceId'] !== null ? (int)$item['invoiceId'] : null], $requested);
        if ($requestedInvoice && count($allocations) === 1 && $allocations[0]['invoiceId'] === null) $allocations[0]['invoiceId'] = (int)$requestedInvoice['id'];
        if (abs(array_sum(array_column($allocations, 'amount')) - $amount) > 0.01 || count(array_unique(array_column($allocations, 'contractId'))) !== count($allocations) || array_filter($allocations, static fn(array $item): bool => $item['contractId'] <= 0 || $item['amount'] <= 0) !== []) hsJson(['error' => 'يجب أن يساوي مجموع التوزيعات مبلغ التحصيل دون تكرار العقود'], 422);
        foreach ($rows as $row) {
            if ($row['kind'] === 'payment' && (string)($row['payload']['operationKey'] ?? '') === $operationKey) {
                if ((float)($row['payload']['amount'] ?? 0) !== $amount || json_encode($row['payload']['allocations'] ?? [], JSON_UNESCAPED_UNICODE) !== json_encode($allocations, JSON_UNESCAPED_UNICODE)) hsJson(['error' => 'مفتاح العملية مستخدم لحمولة مختلفة'], 409);
                $pdo->beginTransaction();
                try {
                    hsPostFinancialCore($pdo, 'payment', (int)$row['id'], $row['payload'], (string)$row['reference'], (int)($row['createdBy'] ?? 0) ?: null);
                    $pdo->commit();
                } catch (Throwable $error) {
                    if ($pdo->inTransaction()) $pdo->rollBack();
                    error_log('[container-system] idempotent payment posting failed: ' . $error->getMessage());
                    hsJson(['error' => 'تعذر استكمال ترحيل الدفعة السابقة؛ لم يُنشأ تحصيل مكرر'], 422);
                }
                $ledger = null;
                foreach ($rows as $candidate) if ($candidate['kind'] === 'ledger_entry' && (int)($candidate['payload']['sourceId'] ?? 0) === (int)$row['id']) { $ledger = $candidate; break; }
                hsJson(['payment' => $row, 'ledgerEntry' => $ledger, 'idempotent' => true]);
            }
        }
        $contractRows = [];
        $returnRows = array_values(array_filter($rows, static fn(array $row): bool => $row['kind'] === 'payment_return' && $row['status'] === 'posted'));
        foreach ($allocations as $allocation) {
            $contract = null;
            foreach ($rows as $row) if ($row['kind'] === 'contract' && (int)$row['id'] === $allocation['contractId'] && $row['status'] !== 'archived') $contract = $row;
            if (!$contract) hsJson(['error' => 'أحد العقود غير موجود أو مؤرشف'], 422);
            $number = (string)($contract['payload']['contractNumber'] ?? $contract['reference']);
            $paid = 0.0;
            foreach (hsPostedCollections($rows) as $row) {
                foreach (($row['payload']['allocations'] ?? []) as $item) {
                    if ((int)($item['contractId'] ?? 0) === $allocation['contractId']) $paid += (float)($item['amount'] ?? 0);
                }
                if (!isset($row['payload']['allocations']) && (string)($row['payload']['contractNumber'] ?? '') === $number) $paid += (float)($row['payload']['amount'] ?? 0);
            }
            foreach ($returnRows as $refund) {
                $refundPayload = $refund['payload'];
                $matches = (int)($refundPayload['contractRecordId'] ?? $refundPayload['contractId'] ?? 0) === $allocation['contractId']
                    || (string)($refundPayload['contractNumber'] ?? '') === $number;
                if (!$matches && !empty($refundPayload['originalPaymentId'])) {
                    foreach (hsPostedCollections($rows) as $payment) {
                        if ((int)$payment['id'] === (int)$refundPayload['originalPaymentId'] &&
                            ((string)($payment['payload']['contractNumber'] ?? '') === $number ||
                             (int)($payment['payload']['contractRecordId'] ?? 0) === $allocation['contractId'])) {
                            $matches = true;
                            break;
                        }
                    }
                }
                if ($matches) $paid -= (float)($refundPayload['amount'] ?? $refundPayload['total'] ?? 0);
            }
            $paid = max($paid, 0);
            $total = (float)($contract['payload']['total'] ?? $contract['payload']['amount'] ?? 0);
            if ($total > 0 && $paid + $allocation['amount'] > $total + 0.01) hsJson(['error' => 'قيمة التحصيل تتجاوز المتبقي في العقد'], 422);
            $contractInvoices = array_values(array_filter($rows, static function (array $row) use ($allocation, $contract, $number): bool {
                if ($row['kind'] !== 'invoice' || $row['status'] === 'archived') return false;
                return (int)($row['payload']['contractRecordId'] ?? 0) === $allocation['contractId']
                    || (string)($row['payload']['contractNumber'] ?? '') === $number;
            }));
            if ($contractInvoices !== [] && $allocation['invoiceId'] === null) {
                hsJson(['error' => 'حدد فاتورة مرحّلة للتحصيل في العقد ' . $number], 422);
            }
            if ($allocation['invoiceId']) {
                $invoice = null; foreach ($rows as $row) if ($row['kind'] === 'invoice' && (int)$row['id'] === $allocation['invoiceId']) $invoice = $row;
                  if (!$invoice || $invoice['status'] === 'archived' || ((int)($invoice['payload']['contractRecordId'] ?? 0) !== $allocation['contractId'] && (string)($invoice['payload']['contractNumber'] ?? '') !== $number)) hsJson(['error' => 'الفاتورة لا تتبع العقد المحدد'], 422);
                  if (!in_array($invoice['status'], ['posted', 'due', 'overdue', 'partially_paid'], true)) hsJson(['error' => 'لا يمكن التحصيل على فاتورة غير مرحّلة أو مغلقة'], 422);
                  $invoicePosting = $pdo->prepare("SELECT id FROM financial_transactions WHERE source_kind = 'invoice' AND source_id = ? AND status = 'posted' LIMIT 1");
                  $invoicePosting->execute([(int)$invoice['id']]);
                  if (!$invoicePosting->fetchColumn()) hsJson(['error' => 'الفاتورة لم تُرحّل إلى النواة المالية بعد'], 422);
                 $invoiceTotal = (float)($invoice['payload']['total'] ?? $invoice['payload']['amount'] ?? 0);
                 $invoicePaid = 0.0;
                 foreach (hsPostedCollections($rows) as $payment) {
                     foreach (($payment['payload']['allocations'] ?? []) as $item) {
                         if ((int)($item['invoiceId'] ?? 0) === $allocation['invoiceId']) $invoicePaid += (float)($item['amount'] ?? 0);
                     }
                     if (!isset($payment['payload']['allocations']) && (int)($payment['payload']['invoiceRecordId'] ?? 0) === $allocation['invoiceId']) {
                         $invoicePaid += (float)($payment['payload']['amount'] ?? 0);
                     }
                 }
                 if ($invoiceTotal > 0 && $invoicePaid + $allocation['amount'] > $invoiceTotal + 0.01) hsJson(['error' => 'قيمة التحصيل تتجاوز المتبقي في الفاتورة'], 422);
            }
            $contractRows[] = ['contract' => $contract, 'number' => $number, 'paid' => $paid, 'total' => $total];
        }
        $first = $contractRows[0]; $now = date('c');
        $firstInvoice = null;
        if (!empty($allocations[0]['invoiceId'])) {
            foreach ($rows as $row) {
                if ($row['kind'] === 'invoice' && (int)$row['id'] === (int)$allocations[0]['invoiceId']) {
                    $firstInvoice = $row;
                    break;
                }
            }
        }
        $paymentPayload = ['operationKey' => $operationKey, 'contractId' => $first['contract']['id'], 'contractNumber' => $first['number'], 'customerRecordId' => $first['contract']['payload']['customerRecordId'] ?? null, 'customerName' => $first['contract']['payload']['customerName'] ?? '', 'amount' => $amount, 'paymentMethod' => $methodName, 'invoiceRecordId' => $allocations[0]['invoiceId'], 'invoiceNumber' => $firstInvoice['payload']['invoiceNumber'] ?? $firstInvoice['reference'] ?? ($input['invoiceNumber'] ?? ''), 'date' => $input['date'] ?? date('Y-m-d'), 'notes' => $input['notes'] ?? '', 'allocations' => array_map(static fn(array $item): array => $item, $allocations)];
            $customerKeys = array_unique(array_map(static function (array $item): string {
                $customerId = (int)($item['contract']['payload']['customerRecordId'] ?? 0);
                return $customerId > 0
                    ? 'id:' . $customerId
                    : 'name:' . mb_strtolower(trim((string)($item['contract']['payload']['customerName'] ?? '')));
            }, $contractRows));
            if (count($customerKeys) > 1 || in_array('name:', $customerKeys, true)) {
                hsJson(['error' => 'لا يمكن توزيع تحصيل واحد إلا على عقود العميل نفسه المرتبطة بعميل رسمي'], 422);
            }
            $deposit = null;
            if (!empty($input['depositId'])) {
                foreach ($rows as $row) if ((int)$row['id'] === (int)$input['depositId'] && in_array($row['kind'], ['deposit', 'bank_deposit'], true) && $row['status'] !== 'archived') $deposit = $row;
                if (!$deposit) hsJson(['error' => 'الإيداع المرتبط غير موجود أو مؤرشف'], 422);
                if (!empty($deposit['payload']['linkedPaymentId'])) hsJson(['error' => 'الإيداع البنكي مرتبط بسداد سابق؛ أنشئ إيداعاً جديداً'], 422);
                $depositAmount = (float)($deposit['payload']['amount'] ?? $deposit['payload']['total'] ?? 0);
                if ($depositAmount > 0 && abs($depositAmount - $amount) > 0.01) hsJson(['error' => 'مبلغ الإيداع لا يطابق مبلغ السداد'], 422);
            }
            $pdo->beginTransaction();
        try {
            $insert = $pdo->prepare("INSERT INTO container_system_records (kind,status,reference,payload,operation_key,created_by,created_at,updated_at) VALUES ('payment','posted',:reference,:payload,:operation_key,:created_by,:created_at,:updated_at)");
            $insert->execute([':reference' => 'PAY-' . time(), ':payload' => json_encode($paymentPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE), ':operation_key' => $operationKey, ':created_by' => $actorId, ':created_at' => $now, ':updated_at' => $now]);
            $paymentId = (int)$pdo->lastInsertId();
            hsPostFinancialCore($pdo, 'payment', $paymentId, $paymentPayload, 'PAY-' . $paymentId, $actorId);
            // Bank reconciliation is created only when the deposit itself is
            // posted; linking a payment must not create a second row.
            $ledgerPayload = ['sourceKind' => 'payment', 'sourceId' => $paymentId, 'contractId' => $first['contract']['id'], 'contractNumber' => $first['number'], 'amount' => $amount, 'direction' => 'credit', 'date' => $paymentPayload['date'], 'allocations' => $allocations];
            $ledgerInsert = $pdo->prepare("INSERT INTO container_system_records (kind,status,reference,payload,created_by,created_at,updated_at) VALUES ('ledger_entry','posted',:reference,:payload,:created_by,:created_at,:updated_at)");
            $ledgerInsert->execute([':reference' => 'LED-' . $paymentId, ':payload' => json_encode($ledgerPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE), ':created_by' => $actorId, ':created_at' => $now, ':updated_at' => $now]);
            $ledgerId = (int)$pdo->lastInsertId();
            foreach ($contractRows as $index => $item) {
                $next = $item['contract']['payload']; $next['paid'] = $item['paid'] + $allocations[$index]['amount']; $next['remaining'] = max($item['total'] - $next['paid'], 0);
                $next['settlementStatus'] = $next['remaining'] <= 0.01 ? 'settled' : 'open';
                $pdo->prepare("UPDATE container_system_records SET payload=:payload,status=:status,updated_at=:updated_at WHERE id=:id")->execute([':payload' => json_encode($next, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE), ':status' => $item['contract']['status'], ':updated_at' => $now, ':id' => $item['contract']['id']]);
                $invoiceId = (int)($allocations[$index]['invoiceId'] ?? 0);
                if ($invoiceId > 0) {
                    foreach ($rows as $invoice) {
                        if ($invoice['kind'] !== 'invoice' || (int)$invoice['id'] !== $invoiceId || $invoice['status'] === 'archived') continue;
                        $invoicePayload = $invoice['payload'];
                        $invoiceTotal = (float)($invoicePayload['total'] ?? $invoicePayload['amount'] ?? 0);
                        $invoicePaid = 0.0;
                        foreach (hsPostedCollections($rows) as $payment) {
                            foreach (($payment['payload']['allocations'] ?? []) as $existingAllocation) {
                                if ((int)($existingAllocation['invoiceId'] ?? 0) === $invoiceId) $invoicePaid += (float)($existingAllocation['amount'] ?? 0);
                            }
                            if (!isset($payment['payload']['allocations']) && (int)($payment['payload']['invoiceRecordId'] ?? 0) === $invoiceId) $invoicePaid += (float)($payment['payload']['amount'] ?? 0);
                        }
                        $invoicePaid += $allocations[$index]['amount'];
                        $invoiceRemaining = max($invoiceTotal - $invoicePaid, 0);
                        $dueDate = (string)($invoicePayload['dueDate'] ?? $invoicePayload['date'] ?? '');
                        $invoiceStatus = $invoiceRemaining <= 0.01 ? 'paid' : ($dueDate !== '' && strtotime($dueDate) < time() ? 'overdue' : ($invoicePaid > 0 ? 'partially_paid' : 'due'));
                        $invoicePayload['paid'] = $invoicePaid;
                        $invoicePayload['remaining'] = $invoiceRemaining;
                        $invoicePayload['invoiceStatus'] = $invoiceStatus;
                        $pdo->prepare("UPDATE container_system_records SET payload=:payload,status=:status,updated_at=:updated_at WHERE id=:id")->execute([':payload' => json_encode($invoicePayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE), ':status' => $invoiceStatus, ':updated_at' => $now, ':id' => $invoiceId]);
                        break;
                    }
                }
            }
            if ($deposit) {
                $depositPayload = $deposit['payload'];
                $depositPayload['linkedContractId'] = $first['contract']['id'];
                $depositPayload['linkedPaymentId'] = $paymentId;
                $pdo->prepare("UPDATE container_system_records SET payload=:payload,updated_at=:updated_at WHERE id=:id")->execute([':payload' => json_encode($depositPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE), ':updated_at' => $now, ':id' => $deposit['id']]);
            }
            $pdo->commit();
            $created = $pdo->prepare("SELECT * FROM container_system_records WHERE id = :id LIMIT 1");
            $created->execute([':id' => $paymentId]);
            $ledgerCreated = $pdo->prepare("SELECT * FROM container_system_records WHERE id = :id LIMIT 1");
            $ledgerCreated->execute([':id' => $ledgerId]);
            hsJson(['payment' => hsRecord($created->fetch(PDO::FETCH_ASSOC)), 'ledgerEntry' => hsRecord($ledgerCreated->fetch(PDO::FETCH_ASSOC)), 'idempotent' => false], 201);
        } catch (Throwable $error) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            error_log('[container-system] payment posting failed: ' . $error->getMessage());
            hsJson(['error' => 'تعذر تسجيل السداد المالي'], 422);
        }
    }
    if ($path === '/admin/container-system/records' && $method === 'GET') {
        $kind = isset($_GET['kind']) ? (string)$_GET['kind'] : null;
        $status = isset($_GET['status']) ? (string)$_GET['status'] : null;
        $search = isset($_GET['search']) ? trim((string)$_GET['search']) : '';
        hsJson(array_map('hsRecord', hsFindRecords($pdo, $kind, $status, $search)));
    }
    if ($path === '/admin/container-system/audit' && $method === 'GET') {
        $rows = $pdo->query("SELECT * FROM container_system_audit ORDER BY created_at DESC, id DESC LIMIT 100")->fetchAll(PDO::FETCH_ASSOC);
        hsJson(array_map(static function(array $row): array {
            $row['id'] = (int)$row['id'];
            $row['recordId'] = isset($row['record_id']) ? (int)$row['record_id'] : null;
            $row['actorId'] = isset($row['actor_id']) ? (int)$row['actor_id'] : null;
            $row['createdAt'] = $row['created_at'] ?? null;
            unset($row['record_id'], $row['actor_id'], $row['created_at']);
            return $row;
        }, $rows));
    }
    if (preg_match('#^/admin/container-system/records/(\d+)$#', $path, $matches)) {
        $id = (int)$matches[1];
        $stmt = $pdo->prepare("SELECT * FROM container_system_records WHERE id = :id LIMIT 1");
        $stmt->execute([':id' => $id]);
        $current = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$current) hsJson(['error' => 'السجل غير موجود'], 404);
        if (!hsCanManage($admin, (string)$current['kind'])) hsJson(['error' => 'ليس لديك صلاحية لهذه العملية'], 403);
        if ($method === 'DELETE') {
            if ($current['kind'] === 'container_movement') hsJson(['error' => 'لا يمكن أرشفة حركة تشغيلية بعد تسجيلها'], 409);
            if ($current['kind'] === 'ledger_entry') hsJson(['error' => 'لا يمكن أرشفة قيد الأستاذ مباشرة؛ صحح المستند المالي الأصلي بحركة عكسية موثقة'], 409);
            $pdo->beginTransaction();
            try {
                $pdo->prepare("UPDATE container_system_records SET status = 'archived', updated_at = :now WHERE id = :id")->execute([':now' => date('c'), ':id' => $id]);
                hsAudit($pdo, $id, (string)$current['kind'], 'archive', $current['payload'], null, $actorId);
                $pdo->commit();
            } catch (Throwable $error) {
                if ($pdo->inTransaction()) $pdo->rollBack();
                throw $error;
            }
            http_response_code(204); exit;
        }
        if ($method === 'PATCH') {
            if ($current['kind'] === 'container_movement') hsJson(['error' => 'حركة التشغيل لا تُعدّل بعد تسجيلها'], 409);
            if ($current['kind'] === 'ledger_entry') hsJson(['error' => 'قيد الأستاذ لا يُعدّل مباشرة؛ صحح المستند المالي الأصلي بحركة عكسية موثقة'], 409);
            $mutationIssue = hsProtectedRecordMutationIssue($current, $input);
            if ($mutationIssue) hsJson(['error' => $mutationIssue['error']], (int)$mutationIssue['status']);
            $payload = array_merge(hsPayload($current['payload']), is_array($input['payload'] ?? null) ? $input['payload'] : []);
            if (in_array((string)$current['kind'], ['container', 'container_asset'], true)) {
                $payload['status'] = hsCanonicalAssetStatus((string)$current['status'], (string)$current['status']);
            }
            $payload = hsNormalizeFinancial((string)$current['kind'], $payload);
            $nextStatus = (string)($input['status'] ?? $current['status']);
            if ($current['kind'] === 'contract' && hsContractPatchRequiresAmendment($pdo, $current, $payload)) {
                hsJson(['error' => 'بدأ تنفيذ العقد أو سُجلت عليه حركة مالية؛ لا تعدّل شروطه مباشرة، ويلزم مسار تعديل تعاقدي موثق'], 409);
            }
            hsValidateFinancialLifecycle($admin, (string)$current['kind'], (string)$current['status'], $nextStatus, $payload);
            if (in_array((string)$current['kind'], hsFinancialLifecycleKinds(), true)
                && in_array((string)$current['status'], ['approved', 'posted', 'cancelled'], true)
                && isset($input['payload'])
                && json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE) !== $current['payload']
                && $nextStatus === (string)$current['status']) {
                hsJson(['error' => 'الحركة المالية المعتمدة لا تعدل مباشرة؛ أنشئ تصحيحاً أو ألغها بسبب موثق'], 409);
            }
            if (in_array((string)$current['kind'], hsFinancialLifecycleKinds(), true) && in_array($nextStatus, ['approved', 'posted'], true)) {
                $payload['approvedAt'] = date('c');
                $payload['approvedBy'] = (int)$admin['id'];
            }
            if (in_array((string)$current['kind'], hsFinancialLifecycleKinds(), true) && $nextStatus === 'cancelled') {
                $payload['cancelledAt'] = date('c');
                $payload['cancelledBy'] = (int)$admin['id'];
            }
            hsValidateRecord($pdo, (string)$current['kind'], $payload, $id);
            if (in_array($current['kind'], ['container', 'container_asset'], true)) $nextStatus = hsCanonicalAssetStatus((string)($payload['status'] ?? ''), $nextStatus);
            $pdo->beginTransaction();
            try {
                $freshStmt = $pdo->prepare("SELECT * FROM container_system_records WHERE id = :id LIMIT 1");
                $freshStmt->execute([':id' => $id]);
                $fresh = $freshStmt->fetch(PDO::FETCH_ASSOC);
                if (!$fresh || (string)($fresh['updated_at'] ?? '') !== (string)($current['updated_at'] ?? '')) {
                    $pdo->rollBack();
                    hsJson(['error' => 'تغير السجل أثناء التعديل؛ أعد تحميله قبل الحفظ'], $fresh ? 409 : 404);
                }
                if (in_array((string)$current['kind'], hsFinancialLifecycleKinds(), true)
                    && $nextStatus === 'posted' && (string)$current['status'] !== 'posted') {
                    $postingIssue = hsFinancialPostingInvariantIssue($pdo, (string)$current['kind'], $payload, $id);
                    if ($postingIssue !== null) {
                        $pdo->rollBack();
                        hsJson(['error' => $postingIssue], 422);
                    }
                }
                if ($fresh['kind'] === 'contract') {
                    if ($nextStatus !== (string)$fresh['status']) {
                        $pdo->rollBack();
                        hsJson(['error' => 'لا تغيّر حالة العقد مباشرة؛ استخدم إجراء دورة العقد المسجل بالحركة'], 409);
                    }
                    if (hsContractPatchRequiresAmendment($pdo, $fresh, $payload)) {
                        $pdo->rollBack();
                        hsJson(['error' => 'بدأ تنفيذ العقد أو سُجلت عليه حركة مالية؛ لا تعدّل شروطه مباشرة، ويلزم مسار تعديل تعاقدي موثق'], 409);
                    }
                    if (in_array($nextStatus, ['active', 'issued', 'scheduled', 'delivered'], true)
                        && hsContractHasOverlappingDates($pdo, $payload, $id)) {
                        $pdo->rollBack();
                        hsJson(['error' => 'الحاوية مرتبطة بعقد آخر خلال نفس الفترة'], 409);
                    }
                }
                $now = date('c');
                $pdo->prepare("UPDATE container_system_records SET status = :status, payload = :payload, updated_at = :updated_at WHERE id = :id")->execute([
                    ':status' => $nextStatus, ':payload' => json_encode($payload, JSON_UNESCAPED_UNICODE), ':updated_at' => $now, ':id' => $id,
                ]);
                hsAudit($pdo, $id, (string)$current['kind'], 'update', $current['payload'], json_encode($payload, JSON_UNESCAPED_UNICODE), $actorId);
                if (in_array((string)$current['kind'], hsFinancialLifecycleKinds(), true) && $current['status'] !== $nextStatus) {
                    hsAudit($pdo, $id, (string)$current['kind'], $nextStatus === 'cancelled' ? 'financial_cancel' : 'financial_status_change',
                        json_encode(['status' => $current['status']], JSON_UNESCAPED_UNICODE),
                        json_encode(['status' => $nextStatus, 'reason' => $payload['reason'] ?? $payload['cancellationReason'] ?? ''], JSON_UNESCAPED_UNICODE),
                        $actorId);
                }
                if (in_array((string)$current['kind'], hsFinancialLifecycleKinds(), true)
                    && (string)$current['status'] === 'posted' && $nextStatus === 'cancelled') {
                    hsReverseFinancialCore(
                        $pdo,
                        (string)$current['kind'],
                        $id,
                        (float)($payload['amount'] ?? $payload['total'] ?? 0),
                        (string)($payload['reason'] ?? $payload['cancellationReason'] ?? 'إلغاء حركة مالية مرحّلة'),
                        $actorId
                    );
                    $reversalExists = $pdo->prepare("SELECT id FROM container_system_records WHERE kind = 'ledger_entry' AND status = 'posted' AND json_extract(payload, '$.entryType') = 'reversal' AND json_extract(payload, '$.originalRecordId') = :id LIMIT 1");
                    $reversalExists->execute([':id' => $id]);
                    if (!$reversalExists->fetchColumn()) {
                        $originalLedgerStmt = $pdo->prepare("SELECT payload, id FROM container_system_records WHERE kind = 'ledger_entry' AND status = 'posted' AND json_extract(payload, '$.sourceId') = :id LIMIT 1");
                        $originalLedgerStmt->execute([':id' => $id]);
                        $originalLedger = $originalLedgerStmt->fetch(PDO::FETCH_ASSOC);
                        $originalLedgerPayload = hsPayload($originalLedger['payload'] ?? null);
                        $originalAmount = (float)($originalLedgerPayload['amount'] ?? $payload['amount'] ?? $payload['total'] ?? 0);
                        $reversalPayload = [
                            'entryType' => 'reversal', 'sourceKind' => $current['kind'], 'sourceId' => $id,
                            'originalRecordId' => $id, 'originalLedgerId' => $originalLedger ? (int)$originalLedger['id'] : null,
                            'amount' => $originalAmount,
                            'direction' => (($originalLedgerPayload['direction'] ?? '') === 'debit') ? 'credit' : 'debit',
                            'reason' => $payload['reason'] ?? $payload['cancellationReason'] ?? 'إلغاء حركة مالية مرحّلة',
                            'date' => date('Y-m-d'),
                        ];
                        $reversalInsert = $pdo->prepare("INSERT INTO container_system_records (kind, status, reference, payload, created_by, created_at, updated_at) VALUES ('ledger_entry', 'posted', :reference, :payload, :created_by, :created_at, :updated_at)");
                        $reversalInsert->execute([
                            ':reference' => 'REV-' . $id,
                            ':payload' => json_encode($reversalPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE),
                            ':created_by' => $actorId, ':created_at' => $now, ':updated_at' => $now,
                        ]);
                    }
                }
                if (in_array((string)$current['kind'], hsFinancialLifecycleKinds(), true) && $nextStatus === 'posted' && $current['status'] !== 'posted') {
                    hsPostFinancialCore(
                        $pdo,
                        (string)$current['kind'],
                        $id,
                        $payload,
                        (string)$current['reference'],
                        $actorId
                    );
                    hsEnsureDepositReconciliation($pdo, $id, (string)$current['kind'], $payload, (string)$current['reference']);
                    $ledger = [
                        'sourceKind' => $current['kind'], 'sourceId' => $id,
                        'contractNumber' => $payload['contractNumber'] ?? '',
                        'contractRecordId' => isset($payload['contractRecordId']) ? (int)$payload['contractRecordId'] : null,
                        'invoiceRecordId' => isset($payload['invoiceRecordId']) ? (int)$payload['invoiceRecordId'] : null,
                        'customerName' => $payload['customerName'] ?? '',
                        'customerRecordId' => isset($payload['customerRecordId']) ? (int)$payload['customerRecordId'] : null,
                        'amount' => (float)($payload['amount'] ?? $payload['total'] ?? 0),
                        'direction' => hsLegacyLedgerDirection((string)$current['kind']),
                        'date' => $payload['date'] ?? date('Y-m-d'),
                    ];
                    if (isset($payload['allocations']) && is_array($payload['allocations'])) $ledger['allocations'] = $payload['allocations'];
                    $ledgerStmt = $pdo->prepare("INSERT INTO container_system_records (kind, status, reference, payload, created_by, created_at, updated_at) VALUES ('ledger_entry', 'posted', :reference, :payload, :created_by, :created_at, :updated_at)");
                    $ledgerStmt->execute([':reference' => 'LED-' . $id, ':payload' => json_encode($ledger, JSON_UNESCAPED_UNICODE), ':created_by' => $actorId, ':created_at' => $now, ':updated_at' => $now]);
                }
                $updated = $pdo->prepare("SELECT * FROM container_system_records WHERE id = :id");
                $updated->execute([':id' => $id]);
                $pdo->commit();
                hsJson(hsRecord($updated->fetch(PDO::FETCH_ASSOC)));
            } catch (Throwable $error) {
                if ($pdo->inTransaction()) $pdo->rollBack();
                throw $error;
            }
        }
    }
    if ($path === '/admin/container-system/records' && $method === 'POST') {
        $kind = trim((string)($input['kind'] ?? ''));
        $payload = is_array($input['payload'] ?? null) ? $input['payload'] : [];
        if (!in_array($kind, hsSupportedKinds(), true)) hsJson(['error' => 'نوع السجل غير مدعوم'], 400);
        if (!hsCanManage($admin, $kind)) hsJson(['error' => 'ليس لديك صلاحية لهذه العملية'], 403);
        $operationKey = trim((string)($_SERVER['HTTP_IDEMPOTENCY_KEY'] ?? $input['operationKey'] ?? $payload['operationKey'] ?? ''));
        if ((in_array($kind, hsFinancialLifecycleKinds(), true) || $kind === 'contract') && $operationKey !== '') {
            if (strlen($operationKey) < 8 || strlen($operationKey) > 160) hsJson(['error' => 'مفتاح العملية غير صالح'], 422);
            $payload['operationKey'] = $operationKey;
            $existingStmt = $pdo->prepare("SELECT * FROM container_system_records WHERE kind = ? AND operation_key = ? AND status <> 'archived' ORDER BY id DESC LIMIT 1");
            $existingStmt = $pdo->prepare("SELECT * FROM container_system_records WHERE kind = ? AND status <> 'archived' AND (operation_key = ? OR json_extract(payload, '$.operationKey') = ?) ORDER BY id DESC LIMIT 1");
            $existingStmt->execute([$kind, $operationKey, $operationKey]);
            $existing = $existingStmt->fetch(PDO::FETCH_ASSOC);
            if ($existing) hsJson(array_merge(hsRecord($existing), ['idempotent' => true]));
        }
        $payload = hsNormalizeFinancial($kind, $payload);
        hsValidateRecord($pdo, $kind, $payload);
        $requestedStatus = (string)($input['status'] ?? '');
        $initialFinancialStatus = null;
        if (in_array($kind, hsFinancialLifecycleKinds(), true)) {
            try {
                $initialFinancialStatus = hsInitialFinancialStatus($requestedStatus);
            } catch (RuntimeException $error) {
                hsJson(['error' => $error->getMessage()], 422);
            }
        }
        $status = in_array($kind, ['container', 'container_asset'], true)
            ? hsCanonicalAssetStatus((string)($payload['status'] ?? ''), (string)($input['status'] ?? 'available'))
            : (in_array($kind, hsFinancialLifecycleKinds(), true)
                ? $initialFinancialStatus
                : (string)($input['status'] ?? 'active'));
        if ($kind === 'contract'
            && in_array($status, ['active', 'issued', 'scheduled', 'delivered'], true)
            && hsContractHasOverlappingDates($pdo, $payload)) {
            hsJson(['error' => 'الحاوية مرتبطة بعقد آخر خلال نفس الفترة'], 409);
        }
        $pdo->beginTransaction();
        try {
            if ($kind === 'contract'
                && in_array($status, ['active', 'issued', 'scheduled', 'delivered'], true)
                && hsContractHasOverlappingDates($pdo, $payload)) {
                $pdo->rollBack();
                hsJson(['error' => 'الحاوية مرتبطة بعقد آخر خلال نفس الفترة'], 409);
            }
            $now = date('c');
            $stmt = $pdo->prepare("INSERT INTO container_system_records (kind, status, reference, payload, operation_key, created_by, created_at, updated_at) VALUES (:kind, :status, '', :payload, :operation_key, :created_by, :created_at, :updated_at)");
            $stmt->execute([':kind' => $kind, ':status' => $status, ':payload' => json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE), ':operation_key' => $operationKey !== '' ? $operationKey : null, ':created_by' => $actorId, ':created_at' => $now, ':updated_at' => $now]);
            $id = (int)$pdo->lastInsertId();
            $reference = hsReference($kind, $payload, $id);
            $pdo->prepare("UPDATE container_system_records SET reference = :reference WHERE id = :id")->execute([':reference' => $reference, ':id' => $id]);
            hsAudit($pdo, $id, $kind, 'create', null, json_encode($payload, JSON_UNESCAPED_UNICODE), $actorId);
            if ($kind === 'container_movement') hsSyncMovement($pdo, $payload, $actorId);
            if (in_array($kind, ['payment', 'receipt', 'expense', 'deposit', 'bank_deposit', 'bank_fee', 'invoice', 'invoice_return', 'payment_return', 'transfer', 'purchase', 'purchase_return', 'other_revenue'], true)
                && $status === 'posted') {
                hsPostFinancialCore($pdo, $kind, $id, $payload, $reference, $actorId);
                hsEnsureDepositReconciliation($pdo, $id, $kind, $payload, $reference);
                $ledger = [
                    'sourceKind' => $kind,
                    'sourceId' => $id,
                    'contractNumber' => $payload['contractNumber'] ?? '',
                    'contractRecordId' => isset($payload['contractRecordId']) ? (int)$payload['contractRecordId'] : null,
                    'invoiceRecordId' => isset($payload['invoiceRecordId']) ? (int)$payload['invoiceRecordId'] : null,
                    'customerName' => $payload['customerName'] ?? '',
                    'customerRecordId' => isset($payload['customerRecordId']) ? (int)$payload['customerRecordId'] : null,
                    'amount' => (float)($payload['amount'] ?? $payload['total'] ?? 0),
                    'direction' => hsLegacyLedgerDirection($kind),
                    'date' => $payload['date'] ?? date('Y-m-d'),
                ];
                if (isset($payload['allocations']) && is_array($payload['allocations'])) $ledger['allocations'] = $payload['allocations'];
                $ledgerStmt = $pdo->prepare("INSERT INTO container_system_records (kind, status, reference, payload, created_by, created_at, updated_at) VALUES ('ledger_entry', 'posted', :reference, :payload, :created_by, :created_at, :updated_at)");
                $ledgerStmt->execute([':reference' => 'LED-' . $id, ':payload' => json_encode($ledger, JSON_UNESCAPED_UNICODE), ':created_by' => $actorId, ':created_at' => $now, ':updated_at' => $now]);
            }
            $created = $pdo->prepare("SELECT * FROM container_system_records WHERE id = :id");
            $created->execute([':id' => $id]);
            $row = $created->fetch(PDO::FETCH_ASSOC);
            $pdo->commit();
            hsJson(hsRecord($row), 201);
        } catch (Throwable $error) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $error;
        }
    }
    hsJson(['error' => 'Route not found'], 404);
}