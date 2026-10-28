<?php
declare(strict_types=1);

/**
 * Promote legacy dispatch rows into canonical work orders without deleting
 * their source records. Ambiguous matches stay separate and require review.
 */
function hsEnsureCanonicalDispatchTasks(PDO $pdo): void {
    $ownsTransaction = !$pdo->inTransaction();
    if ($ownsTransaction) $pdo->beginTransaction();

    try {
        $rows = $pdo->query("SELECT * FROM container_system_records")->fetchAll(PDO::FETCH_ASSOC);
        $workOrders = array_values(array_filter($rows, static fn(array $row): bool =>
            ($row['kind'] ?? '') === 'work_order'
        ));
        $appointments = array_values(array_filter($rows, static fn(array $row): bool =>
            ($row['kind'] ?? '') === 'appointment' && ($row['status'] ?? '') !== 'archived'
        ));
        $parse = static function (array $row): array {
            $payload = json_decode((string)($row['payload'] ?? '{}'), true);
            return is_array($payload) ? $payload : [];
        };
        $operation = static function ($value): ?string {
            $text = trim((string)$value);
            $upper = strtoupper($text);
            if (in_array($upper, ['DELIVER_CONTAINER', 'EMPTY_CONTAINER', 'PICKUP_CONTAINER'], true)) return $upper;
            $emptying = (bool)preg_match('/تفريغ|empty|unload/i', $text);
            $pickup = (bool)preg_match('/استرجاع|سحب|رفع|pickup|return|withdraw/i', $text);
            if ($emptying && $pickup) return null;
            if ($emptying) return 'EMPTY_CONTAINER';
            if ($pickup) return 'PICKUP_CONTAINER';
            if (preg_match('/تسليم|توصيل|deliver|delivery|drop[\s-]?off/i', $text)) return 'DELIVER_CONTAINER';
            return null;
        };
        $sameDispatchState = static function (array $payload, array $request): bool {
            if ((string)($payload['driverStatus'] ?? 'unassigned') !== (string)($request['driver_status'] ?? 'unassigned')
                || (int)($payload['assignedDriverId'] ?? 0) !== (int)($request['assigned_driver_id'] ?? 0)
                || (int)($payload['assignedVehicleId'] ?? 0) !== (int)($request['assigned_vehicle_id'] ?? 0)) {
                return false;
            }
            $fields = [
                'assignedAt' => 'assigned_at',
                'driverResponseAt' => 'driver_response_at',
                'driverStartedAt' => 'driver_started_at',
                'driverCompletedAt' => 'driver_completed_at',
                'driverNotes' => 'driver_notes',
                'driverLocationLat' => 'driver_location_lat',
                'driverLocationLng' => 'driver_location_lng',
                'driverProofPhotoUrl' => 'driver_proof_photo_url',
                'driverSignatureData' => 'driver_signature_data',
                'driverReceiverName' => 'driver_receiver_name',
            ];
            foreach ($fields as $payloadKey => $requestKey) {
                if (trim((string)($payload[$payloadKey] ?? '')) !== trim((string)($request[$requestKey] ?? ''))) return false;
            }
            // service_requests.status and work_order.status have different lifecycle
            // meanings; the driver state and its evidence are the comparable fields.
            return true;
        };
        $insertWorkOrder = static function (
            array $payload,
            string $status,
            string $reference,
            string $operationKey,
            string $auditAction
        ) use ($pdo, &$workOrders): array {
            $existing = $pdo->prepare("SELECT * FROM container_system_records
                WHERE kind='work_order' AND operation_key=:key AND status<>'archived' LIMIT 1");
            $existing->execute([':key' => $operationKey]);
            $found = $existing->fetch(PDO::FETCH_ASSOC);
            if ($found) return $found;

            $now = date('c');
            $encoded = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
            $stmt = $pdo->prepare("INSERT INTO container_system_records
                (kind,status,reference,payload,operation_key,created_by,created_at,updated_at)
                VALUES ('work_order',:status,:reference,:payload,:operation_key,NULL,:created_at,:updated_at)");
            $stmt->execute([
                ':status' => $status,
                ':reference' => $reference,
                ':payload' => $encoded,
                ':operation_key' => $operationKey,
                ':created_at' => $now,
                ':updated_at' => $now,
            ]);
            $id = (int)$pdo->lastInsertId();
            $row = [
                'id' => $id,
                'kind' => 'work_order',
                'status' => $status,
                'reference' => $reference,
                'payload' => $encoded,
                'created_at' => $now,
                'updated_at' => $now,
            ];
            $workOrders[] = $row;
            hsAudit($pdo, $id, 'work_order', $auditAction, null, $encoded, 0);
            return $row;
        };

        $requestRows = $pdo->query("SELECT * FROM service_requests ORDER BY id ASC")->fetchAll(PDO::FETCH_ASSOC);
        foreach ($requestRows as $request) {
            $serviceType = trim((string)($request['service_type'] ?? ''));
            if (preg_match('/(?:عقد|عقود)\s*(?:ال)?(?:نظافة|تنظيف)/u', $serviceType)) continue;
            $requestId = (int)$request['id'];
            $linkedRows = [];
            foreach ($workOrders as $row) {
                if (($row['status'] ?? '') === 'archived') continue;
                if ((int)($parse($row)['legacyRequestId'] ?? 0) === $requestId) $linkedRows[] = $row;
            }
            if (count($linkedRows) === 1) continue;
            if (count($linkedRows) > 1) {
                foreach ($linkedRows as $row) {
                    $payload = $parse($row);
                    if (!empty($payload['reconciliationRequired'])) continue;
                    $before = (string)$row['payload'];
                    $payload['reconciliationRequired'] = true;
                    $payload['reconciliationReason'] = 'أكثر من أمر عمل مرتبط بطلب الخدمة نفسه؛ يلزم مراجعة الإدارة';
                    $encoded = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
                    $pdo->prepare("UPDATE container_system_records SET payload=:payload,updated_at=:updated WHERE id=:id")
                        ->execute([':payload' => $encoded, ':updated' => date('c'), ':id' => (int)$row['id']]);
                    hsAudit($pdo, (int)$row['id'], 'work_order', 'legacy_request_link_conflict', $before, $encoded, 0);
                }
                continue;
            }

            $scheduledAt = trim((string)($request['scheduled_at'] ?? ''));
            $contractId = (int)($request['contract_record_id'] ?? 0);
            $containerId = (int)($request['container_record_id'] ?? 0);
            $candidates = [];
            if ($scheduledAt !== '' && $contractId > 0 && $containerId > 0) {
                foreach ($workOrders as $row) {
                    $payload = $parse($row);
                    if ((int)($payload['contractRecordId'] ?? 0) === $contractId
                        && (int)($payload['containerRecordId'] ?? 0) === $containerId
                        && trim((string)($payload['scheduledAt'] ?? '')) === $scheduledAt) {
                        $candidates[] = $row;
                    }
                }
            }
            $requestOperation = $contractId > 0 && $containerId > 0
                ? $operation($serviceType . ' ' . (string)($request['notes'] ?? ''))
                : null;
            $safeMatch = false;
            if (count($candidates) === 1) {
                $candidate = $candidates[0];
                $candidatePayload = $parse($candidate);
                $candidateOperation = $operation($candidatePayload['operationType'] ?? $candidatePayload['serviceType'] ?? '');
                $safeMatch = ($candidate['status'] ?? '') !== 'archived'
                    && empty($candidatePayload['reconciliationRequired'])
                    && (int)($candidatePayload['legacyRequestId'] ?? 0) === 0
                    && $sameDispatchState($candidatePayload, $request)
                    && $requestOperation !== null
                    && $candidateOperation === $requestOperation;
                if ($safeMatch) {
                    $before = (string)$candidate['payload'];
                    $candidatePayload['legacyRequestId'] = $requestId;
                    $candidatePayload['sourceServiceRequestId'] = $requestId;
                    $encoded = json_encode($candidatePayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
                    $pdo->prepare("UPDATE container_system_records SET payload=:payload,updated_at=:updated WHERE id=:id")
                        ->execute([':payload' => $encoded, ':updated' => date('c'), ':id' => (int)$candidate['id']]);
                    hsAudit($pdo, (int)$candidate['id'], 'work_order', 'legacy_request_linked', $before, $encoded, 0);
                    foreach ($workOrders as &$stored) {
                        if ((int)$stored['id'] === (int)$candidate['id']) $stored['payload'] = $encoded;
                    }
                    unset($stored);
                    continue;
                }
            }

            $payload = [
                'operationKey' => 'legacy-service-request-' . $requestId,
                'workOrderNumber' => 'SR-WO-' . $requestId,
                'legacyRequestId' => $requestId,
                'sourceServiceRequestId' => $requestId,
                'customerRecordId' => (int)($request['customer_record_id'] ?? 0) ?: null,
                'contractRecordId' => $contractId ?: null,
                'containerRecordId' => $containerId ?: null,
                'customerName' => (string)($request['client_name'] ?? ''),
                'clientName' => (string)($request['client_name'] ?? ''),
                'phone' => (string)($request['phone'] ?? ''),
                'email' => (string)($request['email'] ?? ''),
                'serviceType' => $serviceType,
                'operationType' => $requestOperation,
                'containerSize' => (string)($request['container_size'] ?? ''),
                'containerCount' => (int)($request['container_count'] ?? 1),
                'location' => (string)($request['location'] ?? ''),
                'duration' => (string)($request['duration'] ?? ''),
                'notes' => (string)($request['notes'] ?? ''),
                'appointmentType' => (string)($request['appointment_type'] ?? 'immediate'),
                'scheduledAt' => $scheduledAt,
                'assignedDriverId' => (int)($request['assigned_driver_id'] ?? 0) ?: null,
                'assignedVehicleId' => (int)($request['assigned_vehicle_id'] ?? 0) ?: null,
                'assignedVehiclePlate' => $request['assigned_vehicle_plate'] ?? null,
                'assignedAt' => $request['assigned_at'] ?? null,
                'driverStatus' => (string)($request['driver_status'] ?? 'unassigned'),
                'driverResponseAt' => $request['driver_response_at'] ?? null,
                'driverStartedAt' => $request['driver_started_at'] ?? null,
                'driverCompletedAt' => $request['driver_completed_at'] ?? null,
                'driverNotes' => $request['driver_notes'] ?? null,
                'driverLocationLat' => $request['driver_location_lat'] ?? null,
                'driverLocationLng' => $request['driver_location_lng'] ?? null,
                'driverProofPhotoUrl' => $request['driver_proof_photo_url'] ?? null,
                'driverSignatureData' => $request['driver_signature_data'] ?? null,
                'driverReceiverName' => $request['driver_receiver_name'] ?? null,
                'status' => (string)($request['status'] ?? 'pending'),
                'source' => 'legacy_service_request',
            ];
            if ($candidates) {
                $payload['reconciliationRequired'] = true;
                $payload['reconciliationReason'] = 'توجد مهمة مرتبطة بالموعد أو العقد نفسه مع اختلاف أو نقص في حالة التنفيذ؛ يلزم مراجعة الإدارة';
            }
            $insertWorkOrder($payload, (string)($request['status'] ?? 'pending'),
                'SR-WO-' . $requestId, 'legacy-service-request-' . $requestId, 'legacy_request_promoted');
        }

        foreach ($appointments as $appointment) {
            $appointmentId = (int)$appointment['id'];
            $source = $parse($appointment);
            $alreadyLinked = false;
            foreach ($workOrders as $row) {
                if (($row['status'] ?? '') === 'archived') continue;
                $payload = $parse($row);
                if ((int)($payload['appointmentRecordId'] ?? 0) === $appointmentId
                    || (int)($payload['legacyAppointmentId'] ?? 0) === $appointmentId) {
                    $alreadyLinked = true;
                    break;
                }
            }
            if ($alreadyLinked) continue;

            $scheduledAt = trim((string)($source['scheduledAt'] ?? ''));
            if ($scheduledAt === '' && !empty($source['appointmentDate'])) {
                $scheduledAt = (string)$source['appointmentDate'] . 'T' . (string)($source['appointmentTime'] ?? '00:00') . ':00';
            }
            $contractId = (int)($source['contractRecordId'] ?? 0);
            $containerId = (int)($source['containerRecordId'] ?? 0);
            $appointmentOperationText = trim((string)($source['operationType'] ?? $source['serviceType'] ?? ''));
            $appointmentOperation = $operation($appointmentOperationText);
            $workOrderReference = (int)($source['workOrderRecordId'] ?? 0);
            $requestReference = (int)($source['serviceRequestId'] ?? $source['requestId'] ?? 0);
            $linked = null;
            $reviewReason = null;

            if ($workOrderReference > 0) {
                foreach ($workOrders as $row) {
                    if ((int)$row['id'] === $workOrderReference && ($row['status'] ?? '') !== 'archived') {
                        $linked = $row;
                        break;
                    }
                }
                if (!$linked) $reviewReason = 'رابط أمر العمل الصريح للموعد غير موجود أو مؤرشف؛ يلزم مراجعة الإدارة';
            } elseif ($requestReference > 0) {
                foreach ($workOrders as $row) {
                    if (($row['status'] ?? '') !== 'archived'
                        && (int)($parse($row)['legacyRequestId'] ?? 0) === $requestReference) {
                        $linked = $row;
                        break;
                    }
                }
                if (!$linked) $reviewReason = 'رابط طلب الخدمة للموعد لا يقود إلى أمر عمل؛ يلزم مراجعة الإدارة';
            } else {
                $matching = [];
                if ($contractId > 0 && $containerId > 0 && $scheduledAt !== '') {
                    foreach ($workOrders as $row) {
                        $payload = $parse($row);
                        if ((int)($payload['contractRecordId'] ?? 0) === $contractId
                            && (int)($payload['containerRecordId'] ?? 0) === $containerId
                            && trim((string)($payload['scheduledAt'] ?? '')) === $scheduledAt) {
                            $matching[] = $row;
                        }
                    }
                }
                if (count($matching) === 1 && $appointmentOperation !== null) {
                    $candidatePayload = $parse($matching[0]);
                    $candidateOperation = $operation($candidatePayload['operationType'] ?? $candidatePayload['serviceType'] ?? '');
                    if (($matching[0]['status'] ?? '') !== 'archived'
                        && empty($candidatePayload['reconciliationRequired'])
                        && (int)($candidatePayload['appointmentRecordId'] ?? 0) === 0
                        && $candidateOperation === $appointmentOperation) {
                        $linked = $matching[0];
                    } else {
                        $reviewReason = 'تعذر التحقق من تطابق العملية أو رابط الموعد؛ يلزم مراجعة الإدارة';
                    }
                } elseif ($matching) {
                    $reviewReason = count($matching) > 1
                        ? 'تعذر ربط الموعد بأمر تشغيل واحد بشكل آمن؛ يلزم مراجعة الإدارة'
                        : 'نوع العملية أو رابط الموعد غير مؤكد؛ يلزم مراجعة الإدارة';
                }
            }

            if (!$linked && $appointmentOperation === null && !$reviewReason) {
                $reviewReason = 'نوع عملية الموعد غير محدد؛ يلزم مراجعة الإدارة قبل التنفيذ';
            }

            if ($linked) {
                $linkedPayload = $parse($linked);
                $previousAppointmentId = (int)($linkedPayload['appointmentRecordId'] ?? 0);
                if ($previousAppointmentId > 0 && $previousAppointmentId !== $appointmentId) {
                    $linked = null;
                    $reviewReason = 'أمر العمل مرتبط مسبقًا بموعد آخر؛ يلزم مراجعة الإدارة';
                }
                $linkedSchedule = trim((string)($linkedPayload['scheduledAt'] ?? ''));
                if ($linked && $linkedSchedule !== '' && $scheduledAt !== '' && $linkedSchedule !== $scheduledAt) {
                    $reviewReason = 'موعد الجدولة يختلف عن الوقت المحفوظ في أمر العمل؛ يلزم مراجعة الإدارة';
                }
                $linkedOperation = $operation($linkedPayload['operationType'] ?? $linkedPayload['serviceType'] ?? '');
                if ($linked && $appointmentOperationText !== '' && $appointmentOperation === null) {
                    $reviewReason = 'نوع عملية الموعد ملتبس؛ يلزم مراجعة الإدارة';
                } elseif ($linked && $appointmentOperation !== null && $linkedOperation !== null
                    && $appointmentOperation !== $linkedOperation) {
                    $reviewReason = 'نوع عملية الموعد يختلف عن نوع أمر العمل؛ يلزم مراجعة الإدارة';
                }
                if ($linked && (
                    ((int)($source['assignedDriverId'] ?? 0) > 0
                        && (int)($source['assignedDriverId'] ?? 0) !== (int)($linkedPayload['assignedDriverId'] ?? 0))
                    || ((int)($source['assignedVehicleId'] ?? 0) > 0
                        && (int)($source['assignedVehicleId'] ?? 0) !== (int)($linkedPayload['assignedVehicleId'] ?? 0))
                )) {
                    $reviewReason = 'إسناد السائق أو الشاحنة يختلف بين الموعد وأمر العمل؛ يلزم مراجعة الإدارة';
                }
                if (!$linked) {
                    $createReviewOrder = true;
                } else {
                    $before = (string)$linked['payload'];
                    $linkedPayload['appointmentRecordId'] = $appointmentId;
                    $linkedPayload['legacyAppointmentId'] = $appointmentId;
                    if ($linkedSchedule === '' && $scheduledAt !== '') $linkedPayload['scheduledAt'] = $scheduledAt;
                    if (empty($linkedPayload['appointmentType']) && !empty($source['appointmentType'])) {
                        $linkedPayload['appointmentType'] = $source['appointmentType'];
                    } elseif (!empty($linkedPayload['appointmentType']) && !empty($source['appointmentType'])
                        && (string)$linkedPayload['appointmentType'] !== (string)$source['appointmentType']) {
                        $reviewReason = 'نوع الموعد يختلف عن القيمة المحفوظة في أمر العمل؛ يلزم مراجعة الإدارة';
                        $linkedPayload['legacyAppointmentType'] = $source['appointmentType'];
                    }
                    if ($reviewReason) {
                        $linkedPayload['reconciliationRequired'] = true;
                        $linkedPayload['reconciliationReason'] = $reviewReason;
                        if ($linkedSchedule !== '' && $scheduledAt !== '' && $linkedSchedule !== $scheduledAt) {
                            $linkedPayload['legacyAppointmentScheduledAt'] = $scheduledAt;
                        }
                    }
                    $encoded = json_encode($linkedPayload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
                    $pdo->prepare("UPDATE container_system_records SET payload=:payload,updated_at=:updated WHERE id=:id")
                        ->execute([':payload' => $encoded, ':updated' => date('c'), ':id' => (int)$linked['id']]);
                    hsAudit($pdo, (int)$linked['id'], 'work_order', 'legacy_appointment_linked', $before, $encoded, 0);
                    foreach ($workOrders as &$stored) {
                        if ((int)$stored['id'] === (int)$linked['id']) $stored['payload'] = $encoded;
                    }
                    unset($stored);
                    continue;
                }
            } else {
                $createReviewOrder = (bool)$reviewReason;
            }

            $operationType = $appointmentOperation;
            $payload = [
                'operationKey' => 'legacy-appointment-' . $appointmentId,
                'workOrderNumber' => 'APT-WO-' . $appointmentId,
                'legacyAppointmentId' => $appointmentId,
                'appointmentRecordId' => $appointmentId,
                'customerRecordId' => (int)($source['customerRecordId'] ?? 0) ?: null,
                'customerName' => (string)($source['customerName'] ?? $source['clientName'] ?? ''),
                'phone' => (string)($source['phone'] ?? ''),
                'contractRecordId' => $contractId ?: null,
                'containerRecordId' => $containerId ?: null,
                'containerCode' => (string)($source['containerCode'] ?? ''),
                'serviceType' => (string)($source['serviceType'] ?? $source['operationType'] ?? 'موعد تشغيل'),
                'operationType' => $operationType ?? 'APPOINTMENT',
                'location' => (string)($source['location'] ?? 'يحدد لاحقًا'),
                'duration' => (string)($source['duration'] ?? ''),
                'appointmentType' => (string)($source['appointmentType'] ?? 'scheduled'),
                'scheduledAt' => $scheduledAt,
                'assignedDriverId' => (int)($source['assignedDriverId'] ?? 0) ?: null,
                'assignedVehicleId' => (int)($source['assignedVehicleId'] ?? 0) ?: null,
                'assignedVehiclePlate' => $source['assignedVehiclePlate'] ?? null,
                'assignedAt' => $source['assignedAt'] ?? null,
                'driverStatus' => (string)($source['driverStatus'] ?? ((int)($source['assignedDriverId'] ?? 0) > 0 ? 'assigned' : 'unassigned')),
                'driverResponseAt' => $source['driverResponseAt'] ?? null,
                'driverStartedAt' => $source['driverStartedAt'] ?? null,
                'driverCompletedAt' => $source['driverCompletedAt'] ?? null,
                'driverNotes' => $source['driverNotes'] ?? null,
                'driverLocationLat' => $source['driverLocationLat'] ?? null,
                'driverLocationLng' => $source['driverLocationLng'] ?? null,
                'driverProofPhotoUrl' => $source['driverProofPhotoUrl'] ?? null,
                'driverSignatureData' => $source['driverSignatureData'] ?? null,
                'driverReceiverName' => $source['driverReceiverName'] ?? null,
                'status' => (string)($source['status'] ?? $appointment['status'] ?? 'new'),
                'source' => 'appointment_migration',
            ];
            if ($createReviewOrder) {
                $payload['reconciliationRequired'] = true;
                $payload['reconciliationReason'] = $reviewReason
                    ?: 'تعذر ربط الموعد بأمر تشغيل واحد بشكل آمن؛ يلزم مراجعة الإدارة';
            }
            $insertWorkOrder($payload, (string)($appointment['status'] ?? 'new'),
                'APT-WO-' . $appointmentId, 'legacy-appointment-' . $appointmentId, 'legacy_appointment_promoted');
        }

        if ($ownsTransaction) $pdo->commit();
    } catch (Throwable $error) {
        if ($ownsTransaction && $pdo->inTransaction()) $pdo->rollBack();
        throw $error;
    }
}
