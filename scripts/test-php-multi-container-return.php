<?php
declare(strict_types=1);

require __DIR__ . '/container-system.php';

function multiReturnExpectSame($expected, $actual, string $message, string $detail = ''): void {
    if ($expected !== $actual) {
        throw new RuntimeException($message . ': expected ' . var_export($expected, true) .
            ', got ' . var_export($actual, true) . ($detail !== '' ? ' — ' . $detail : ''));
    }
}

function multiReturnRequest(string $url, string $method, ?array $body = null, ?string $token = null, ?string $visitorSession = null): array {
    $headers = ['Content-Type: application/json'];
    if ($token !== null) $headers[] = 'Authorization: Bearer ' . $token;
    if ($visitorSession !== null) $headers[] = 'X-Visitor-Session: ' . $visitorSession;
    $options = [
        'http' => [
            'method' => $method,
            'header' => implode("\r\n", $headers),
            'content' => $body === null ? '' : json_encode($body, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE),
            'timeout' => 5,
            'ignore_errors' => true,
        ],
    ];
    $response = @file_get_contents($url, false, stream_context_create($options));
    $status = 0;
    foreach (($http_response_header ?? []) as $header) {
        if (preg_match('#^HTTP/\S+\s+(\d+)#', $header, $match)) $status = (int)$match[1];
    }
    $raw = is_string($response) ? $response : '';
    $decoded = json_decode($raw, true);
    return [$status, is_array($decoded) ? $decoded : [], $raw];
}

$testRoot = sys_get_temp_dir() . '/cleanflow-php-multi-return-' . bin2hex(random_bytes(6));
$server = null;
$serverPipes = [];
$cleanup = static function (string $path) use (&$cleanup): void {
    if (!is_dir($path)) {
        if (file_exists($path)) @unlink($path);
        return;
    }
    foreach (scandir($path) ?: [] as $entry) {
        if ($entry === '.' || $entry === '..') continue;
        $child = $path . DIRECTORY_SEPARATOR . $entry;
        if (is_dir($child)) $cleanup($child);
        else @unlink($child);
    }
    @rmdir($path);
};

try {
    mkdir($testRoot . '/scripts', 0777, true);
    mkdir($testRoot . '/data', 0777, true);
    copy(__DIR__ . '/api-index.php', $testRoot . '/scripts/api-index.php');
    copy(__DIR__ . '/container-system.php', $testRoot . '/scripts/container-system.php');
    copy(__DIR__ . '/dispatch-canonicalization.php', $testRoot . '/scripts/dispatch-canonicalization.php');

    $databasePath = $testRoot . '/data/sabaik.db';
    $pdo = new PDO('sqlite:' . $databasePath);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    hsPrepareServiceRequestsTable($pdo);
    hsEnsureSchema($pdo);
    $pdo->exec("CREATE TABLE conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        email TEXT DEFAULT '',
        subject TEXT,
        package_id INTEGER,
        package_name TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        last_message TEXT NOT NULL DEFAULT '',
        unread_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )");
    $pdo->exec("CREATE TABLE active_visitors (
        session_id TEXT PRIMARY KEY,
        page TEXT NOT NULL DEFAULT '/',
        device_type TEXT NOT NULL DEFAULT 'desktop',
        conversation_id INTEGER,
        client_name TEXT,
        phone TEXT,
        invitation_message TEXT,
        invitation_created_at TEXT,
        last_seen TEXT NOT NULL
    )");
    $pdo->exec("CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL,
        sender_type TEXT NOT NULL,
        content TEXT NOT NULL,
        message_type TEXT DEFAULT 'text',
        metadata TEXT,
        attachment_url TEXT,
        attachment_type TEXT,
        location_lat TEXT,
        location_lng TEXT,
        location_label TEXT,
        is_read TEXT DEFAULT 'false',
        created_at TEXT NOT NULL
    )");
    $pdo->exec("CREATE TABLE notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'system',
        is_read INTEGER NOT NULL DEFAULT 0,
        ref_id INTEGER,
        ref_type TEXT,
        created_at TEXT NOT NULL
    )");
    $pdo->exec("CREATE TABLE admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'admin',
        permissions TEXT NOT NULL DEFAULT '[]',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_by INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )");
    $testPassword = 'cleanflow-php-multi-return-test-only';
    $adminInsert = $pdo->prepare("INSERT INTO admins (username,password_hash,name,role,is_active,permissions)
        VALUES (:username,:password_hash,:name,:role,1,:permissions)");
    $adminInsert->execute([
        ':username' => 'multi-return-test-admin',
        ':password_hash' => password_hash($testPassword, PASSWORD_DEFAULT),
        ':name' => 'TEST ONLY — Admin',
        ':role' => 'admin',
        ':permissions' => '[]',
    ]);
    $adminId = (int)$pdo->lastInsertId();
    $adminInsert->execute([
        ':username' => 'multi-return-test-driver',
        ':password_hash' => password_hash($testPassword, PASSWORD_DEFAULT),
        ':name' => 'TEST ONLY — Driver',
        ':role' => 'driver',
        ':permissions' => '[]',
    ]);
    $driverId = (int)$pdo->lastInsertId();

    $now = date('c');
    $insertRecord = static function (string $kind, string $status, string $reference, array $payload) use ($pdo, $now): int {
        $insert = $pdo->prepare("INSERT INTO container_system_records
            (kind,status,reference,payload,created_by,created_at,updated_at) VALUES (?,?,?,?,1,?,?)");
        $insert->execute([
            $kind, $status, $reference,
            json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE),
            $now, $now,
        ]);
        return (int)$pdo->lastInsertId();
    };

    $nearLocation = 'TEST ONLY — 24.7136,46.6753';
    $fixtures = [];
    foreach ([
        ['TEST-PHP-RETURN-001', $nearLocation],
        ['TEST-PHP-RETURN-002', $nearLocation],
        ['TEST-PHP-RETURN-FAR-003', 'TEST ONLY — 25.5000,48.0000'],
    ] as [$code, $location]) {
        $assetId = $insertRecord('container_asset', 'rented', $code, [
            'assetCode' => $code,
            'status' => 'rented',
            'location' => $location,
        ]);
        $contractId = $insertRecord('contract', 'delivered', 'CONTRACT-' . $code, [
            'contractNumber' => 'CONTRACT-' . $code,
            'containerRecordId' => $assetId,
            'containerCode' => $code,
            'customerRecordId' => 9001,
            'customerName' => 'TEST ONLY',
            'location' => $location,
            'preservedTestField' => 'preserve-' . $code,
        ]);
        $fixtures[] = ['assetId' => $assetId, 'contractId' => $contractId, 'code' => $code];
    }

    $workOrderPayload = [
        'operationKey' => 'test-only-multi-return-work-order',
        'serviceType' => 'استرجاع حاوية',
        'operationType' => 'PICKUP_CONTAINER',
        'movementType' => 'سحب',
        'contractRecordId' => $fixtures[0]['contractId'],
        'containerRecordId' => $fixtures[0]['assetId'],
        'contractRecordIds' => [$fixtures[0]['contractId']],
        'containerRecordIds' => [$fixtures[0]['assetId']],
        'containerCodes' => [$fixtures[0]['code']],
        'containerCount' => 1,
        'assignedDriverId' => $driverId,
        'driverStatus' => 'assigned',
        'status' => 'assigned',
        'location' => $nearLocation,
    ];
    $workOrderId = $insertRecord('work_order', 'assigned', 'TEST-PHP-MULTI-RETURN-WO', $workOrderPayload);
    $pdo = null;

    $socket = stream_socket_server('tcp://127.0.0.1:0', $errno, $error);
    if (!$socket) throw new RuntimeException('Could not allocate a local test port: ' . $error);
    $address = stream_socket_get_name($socket, false);
    fclose($socket);
    $port = (int)substr((string)$address, strrpos((string)$address, ':') + 1);
    putenv('SESSION_SECRET=cleanflow-php-multi-return-test-session-secret');
    $server = proc_open(
        [PHP_BINARY, '-S', '127.0.0.1:' . $port, '-t', $testRoot, $testRoot . '/scripts/api-index.php'],
        [
            0 => ['pipe', 'r'],
            1 => ['file', '/dev/null', 'a'],
            2 => ['file', '/dev/null', 'a'],
        ],
        $serverPipes,
        $testRoot,
    );
    if (!is_resource($server)) throw new RuntimeException('Could not start the isolated PHP API server');
    fclose($serverPipes[0]);
    $baseUrl = 'http://127.0.0.1:' . $port . '/api';
    $ready = false;
    for ($attempt = 0; $attempt < 40; $attempt++) {
        [$healthStatus] = multiReturnRequest($baseUrl . '/healthz', 'GET');
        if ($healthStatus === 200) {
            $ready = true;
            break;
        }
        usleep(100000);
    }
    if (!$ready) throw new RuntimeException('The isolated PHP API server did not become ready');

    $ownerSession = 'TEST-ONLY-PHP-CONVERSATION-OWNER';
    [$conversationStatus, $conversation, $conversationRaw] = multiReturnRequest(
        $baseUrl . '/conversations',
        'POST',
        ['clientName' => 'TEST ONLY — Conversation owner', 'phone' => '0000000000'],
        null,
        $ownerSession,
    );
    multiReturnExpectSame(201, $conversationStatus, 'the public conversation should be created', $conversationRaw);
    $conversationId = (int)($conversation['id'] ?? 0);
    if ($conversationId <= 0) throw new RuntimeException('The public conversation did not return an ID');
    $attackerSession = 'TEST-ONLY-PHP-CONVERSATION-OTHER';
    [$heartbeatStatus] = multiReturnRequest(
        $baseUrl . '/visitor/heartbeat',
        'POST',
        ['sessionId' => $attackerSession, 'conversationId' => $conversationId],
    );
    multiReturnExpectSame(200, $heartbeatStatus, 'public presence heartbeats should still be accepted');
    [$ownerReadStatus] = multiReturnRequest(
        $baseUrl . '/conversations/' . $conversationId . '/messages',
        'GET',
        null,
        null,
        $ownerSession,
    );
    multiReturnExpectSame(200, $ownerReadStatus, 'the owning visitor should retain access to the conversation');
    [$otherReadStatus] = multiReturnRequest(
        $baseUrl . '/conversations/' . $conversationId . '/messages',
        'GET',
        null,
        null,
        $attackerSession,
    );
    multiReturnExpectSame(403, $otherReadStatus, 'a heartbeat must not grant another visitor access to conversation messages');

    [$adminLoginStatus, $adminLogin, $adminLoginRaw] = multiReturnRequest($baseUrl . '/auth/login', 'POST', [
        'username' => 'multi-return-test-admin',
        'password' => $testPassword,
    ]);
    multiReturnExpectSame(200, $adminLoginStatus, 'the synthetic admin login must work', $adminLoginRaw);
    $adminToken = (string)($adminLogin['token'] ?? '');
    if ($adminToken === '') throw new RuntimeException('The PHP API did not return the synthetic admin token');

    [$adminOrdersStatus, $adminOrders, $adminOrdersRaw] = multiReturnRequest($baseUrl . '/admin/work-orders', 'GET', null, $adminToken);
    multiReturnExpectSame(200, $adminOrdersStatus, 'the admin list should include operational work orders', $adminOrdersRaw);
    $adminOrder = null;
    foreach ($adminOrders as $listedOrder) {
        if ((int)($listedOrder['id'] ?? 0) === $workOrderId && ($listedOrder['operationKey'] ?? '') === $workOrderPayload['operationKey']) {
            $adminOrder = $listedOrder;
            break;
        }
    }
    if (!$adminOrder) throw new RuntimeException('The admin work-order list did not include the operational return task');

    [$addedStatus, $added, $addedRaw] = multiReturnRequest(
        $baseUrl . '/admin/work-orders/' . $workOrderId . '/containers',
        'PATCH',
        ['containerRecordId' => $fixtures[1]['assetId']],
        $adminToken,
    );
    multiReturnExpectSame(200, $addedStatus, 'a nearby delivered container should be added', $addedRaw);
    multiReturnExpectSame([$fixtures[0]['assetId'], $fixtures[1]['assetId']], $added['containerRecordIds'] ?? null,
        'the task should retain both container IDs');
    multiReturnExpectSame([$fixtures[0]['contractId'], $fixtures[1]['contractId']], $added['contractRecordIds'] ?? null,
        'each container should keep its matching contract ID');

    [$distantStatus] = multiReturnRequest(
        $baseUrl . '/admin/work-orders/' . $workOrderId . '/containers',
        'PATCH',
        ['containerRecordId' => $fixtures[2]['assetId']],
        $adminToken,
    );
    multiReturnExpectSame(409, $distantStatus, 'a distant container must not join this route');

    [$driverLoginStatus, $driverLogin, $driverLoginRaw] = multiReturnRequest($baseUrl . '/auth/login', 'POST', [
        'username' => 'multi-return-test-driver',
        'password' => $testPassword,
    ]);
    multiReturnExpectSame(200, $driverLoginStatus, 'the synthetic driver login must work', $driverLoginRaw);
    $driverToken = (string)($driverLogin['token'] ?? '');
    if ($driverToken === '') throw new RuntimeException('The PHP API did not return the synthetic driver token');
    [$driverOrdersStatus, $driverOrders, $driverOrdersRaw] = multiReturnRequest($baseUrl . '/driver/work-orders', 'GET', null, $driverToken);
    multiReturnExpectSame(200, $driverOrdersStatus, 'the driver list should include assigned operational work orders', $driverOrdersRaw);
    $driverOrderFound = false;
    foreach ($driverOrders as $listedOrder) {
        if ((int)($listedOrder['id'] ?? 0) === $workOrderId && ($listedOrder['operationKey'] ?? '') === $workOrderPayload['operationKey']) {
            $driverOrderFound = true;
            break;
        }
    }
    multiReturnExpectSame(true, $driverOrderFound, 'the driver list should include the assigned return task');

    $updateTask = static function (string $status, bool $withEvidence = false) use ($baseUrl, $workOrderId, $driverToken): array {
        return multiReturnRequest($baseUrl . '/driver/work-orders/' . $workOrderId, 'PATCH', [
            'status' => $status,
            ...($withEvidence ? [
                'receiverName' => 'TEST ONLY — Receiver',
                'proofPhotoUrl' => '/uploads/TEST-ONLY-php-return-proof.webp',
                'signatureData' => 'TEST ONLY — signature',
                'locationLat' => '24.7136',
                'locationLng' => '46.6753',
            ] : []),
        ], $driverToken);
    };
    foreach (['accepted', 'started', 'en_route', 'arrived'] as $status) {
        [$statusCode, , $statusRaw] = $updateTask($status);
        multiReturnExpectSame(200, $statusCode, 'driver transition to ' . $status, $statusRaw);
    }

    $pdo = new PDO('sqlite:' . $databasePath);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->prepare("UPDATE container_system_records SET status = 'available', payload = json_set(payload, '$.status', 'available') WHERE id = ?")
        ->execute([$fixtures[1]['assetId']]);
    [$blockedStatus] = $updateTask('completed', true);
    multiReturnExpectSame(422, $blockedStatus, 'one ineligible container must reject the whole return');
    multiReturnExpectSame('delivered', (string)$pdo->query("SELECT status FROM container_system_records WHERE id = {$fixtures[0]['contractId']}")->fetchColumn(),
        'a rejected return must not partially update the first contract');
    multiReturnExpectSame('rented', (string)$pdo->query("SELECT status FROM container_system_records WHERE id = {$fixtures[0]['assetId']}")->fetchColumn(),
        'a rejected return must not partially release the first asset');

    $pdo->prepare("UPDATE container_system_records SET status = 'rented', payload = json_set(payload, '$.status', 'rented') WHERE id = ?")
        ->execute([$fixtures[1]['assetId']]);
    [$completeStatus, , $completeRaw] = $updateTask('completed', true);
    multiReturnExpectSame(200, $completeStatus, 'all eligible containers should return together', $completeRaw);
    foreach (array_slice($fixtures, 0, 2) as $fixture) {
        multiReturnExpectSame('returned', (string)$pdo->query("SELECT status FROM container_system_records WHERE id = {$fixture['contractId']}")->fetchColumn(),
            'each contract should become returned');
        multiReturnExpectSame('available', (string)$pdo->query("SELECT status FROM container_system_records WHERE id = {$fixture['assetId']}")->fetchColumn(),
            'each returned asset should become available');
        $contractPayload = json_decode((string)$pdo->query("SELECT payload FROM container_system_records WHERE id = {$fixture['contractId']}")->fetchColumn(), true) ?: [];
        multiReturnExpectSame('preserve-' . $fixture['code'], $contractPayload['preservedTestField'] ?? null,
            'the existing contract payload must be preserved');
        multiReturnExpectSame($workOrderId, (int)($contractPayload['lastWorkOrderId'] ?? 0),
            'the contract should retain the work-order link');
        if (empty($contractPayload['returnAt'])) throw new RuntimeException('The return timestamp was not saved to the contract payload');
    }
    $movementRows = $pdo->query("SELECT payload FROM container_system_records WHERE kind = 'container_movement'")->fetchAll(PDO::FETCH_COLUMN);
    $workOrderMovements = [];
    foreach ($movementRows as $movementRaw) {
        $movementPayload = json_decode((string)$movementRaw, true) ?: [];
        if ((int)($movementPayload['workOrderId'] ?? 0) === $workOrderId) $workOrderMovements[] = $movementPayload;
    }
    multiReturnExpectSame(2, count($workOrderMovements), 'each returned container must create its own movement');
    foreach ($workOrderMovements as $movementPayload) {
        multiReturnExpectSame('/uploads/TEST-ONLY-php-return-proof.webp', $movementPayload['proofPhotoUrl'] ?? null,
            'each movement should keep the driver photo');
        multiReturnExpectSame('TEST ONLY — signature', $movementPayload['signatureData'] ?? null,
            'each movement should keep the driver signature');
        multiReturnExpectSame('TEST ONLY — Receiver', $movementPayload['receiverName'] ?? null,
            'each movement should keep the receiver name');
        multiReturnExpectSame($driverId, (int)($movementPayload['driverId'] ?? 0),
            'each movement should identify the driver');
        multiReturnExpectSame('24.7136', $movementPayload['locationLat'] ?? null,
            'each movement should keep the latitude');
        multiReturnExpectSame('46.6753', $movementPayload['locationLng'] ?? null,
            'each movement should keep the longitude');
    }

    echo "PHP multi-container return assertions passed using an isolated temporary database\n";
} finally {
    if (is_resource($server)) {
        @proc_terminate($server);
        @proc_close($server);
    }
    $cleanup($testRoot);
}
