import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { OfflineCard } from '@/components/OfflineCard';
import { ThemedText } from '@/components/ThemedText';
import { ThemedTextInput, ThemedView } from '@/components/Themed';
import {
  clearDeviceBaseUrl,
  getDeviceBaseUrl,
  getStatus,
  resolveDeviceBaseUrl,
  saveCalibration,
  setDeviceBaseUrl,
  startCalibration,
  startPrime,
  stopCalibration,
  stopPrime,
} from '@/src/api/client';
import { Colors, Radius, Spacing, Typography } from '@/constants/Theme';
import {
  isPrimeGoneError,
  reconcileAfterPrimeGone,
  reconcilePrime,
} from '@/src/prime/reconcile';
import { type PrimeResult, type PumpId } from '@reef/shared';

const PUMP_ORDER: PumpId[] = ['alk', 'ca', 'no3', 'po4'];

type WizardStep = 1 | 2 | 3 | 4;

interface CalibrationResult {
  pumpId: PumpId;
  oldStepsPerMl: number | null;
  newStepsPerMl: number;
  totalSteps: number;
  measuredMl: number;
}

function CalibrationWizard({
  pumpId,
  oldStepsPerMl,
  queueDepth,
  visible,
  onClose,
}: {
  pumpId: PumpId;
  oldStepsPerMl: number | null;
  queueDepth: number;
  visible: boolean;
  onClose: () => void;
}) {
  const [step, setStep] = useState<WizardStep>(1);
  const [safetyChecked, setSafetyChecked] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [totalSteps, setTotalSteps] = useState(0);
  const [measuredMl, setMeasuredMl] = useState('');
  const [result, setResult] = useState<CalibrationResult | null>(null);
  const [error, setError] = useState('');
  const [baseUrl, setBaseUrl] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      getDeviceBaseUrl().then((url) => {
        if (mounted) setBaseUrl(resolveDeviceBaseUrl(url));
      });
      return () => {
        mounted = false;
      };
    }, []),
  );

  const reset = () => {
    setStep(1);
    setSafetyChecked(false);
    setIsRunning(false);
    setTotalSteps(0);
    setMeasuredMl('');
    setResult(null);
    setError('');
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleStart = async () => {
    if (!baseUrl) return;
    setError('');
    try {
      await startCalibration(baseUrl, { pumpId });
      setIsRunning(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start');
    }
  };

  const handleStop = async () => {
    if (!baseUrl) return;
    setError('');
    try {
      const res = await stopCalibration(baseUrl, { pumpId });
      setIsRunning(false);
      setTotalSteps(res.totalSteps);
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop');
    }
  };

  const handleSave = async () => {
    if (!baseUrl) return;
    const ml = parseFloat(measuredMl);
    if (!ml || ml <= 0) {
      setError('Enter a positive measured volume');
      return;
    }
    setError('');

    try {
      const res = await saveCalibration(baseUrl, {
        pumpId,
        measuredMl: ml,
        totalSteps,
      });
      setResult({
        pumpId,
        oldStepsPerMl,
        newStepsPerMl: res.stepsPerMl,
        totalSteps,
        measuredMl: ml,
      });
      setStep(4);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const previewStepsPerMl = useMemo(() => {
    const ml = parseFloat(measuredMl);
    if (!ml || ml <= 0 || totalSteps <= 0) return null;
    return totalSteps / ml;
  }, [measuredMl, totalSteps]);

  const blocked = queueDepth > 0;

  const content = (() => {
    if (blocked) {
      return (
        <>
          <ThemedText style={styles.wizardTitle}>Calibration blocked</ThemedText>
          <ThemedText style={styles.warningText}>
            A dose is currently queued or running. Wait for it to finish before calibrating.
          </ThemedText>
          <Pressable style={styles.primaryButton} onPress={handleClose}>
            <ThemedText style={styles.primaryButtonText}>Close</ThemedText>
          </Pressable>
        </>
      );
    }

    switch (step) {
      case 1:
        return (
          <>
            <ThemedText style={styles.wizardTitle}>
              Calibrate {pumpId.toUpperCase()}
            </ThemedText>
            <ThemedText style={styles.wizardSubtitle}>
              This changes all future doses for this pump.
            </ThemedText>

            <ThemedView style={styles.warningCard}>
              <ThemedText style={styles.warningHeading}>Safety check</ThemedText>
              <ThemedText style={styles.bodyText}>
                1. Remove the dosing tube from the aquarium.
              </ThemedText>
              <ThemedText style={styles.bodyText}>
                2. Place the outlet into a measuring cup or small container.
              </ThemedText>
              <ThemedText style={styles.bodyText}>
                3. Keep the tube submerged so it cannot siphon tank water.
              </ThemedText>
            </ThemedView>

            <ThemedView style={styles.toggleRow}>
              <ThemedText style={styles.bodyText}>
                I've done this and the area is clear.
              </ThemedText>
              <Switch
                value={safetyChecked}
                onValueChange={setSafetyChecked}
                trackColor={{ false: Colors.slate, true: Colors.aqua }}
                thumbColor={safetyChecked ? Colors.pearl : Colors.titanium}
              />
            </ThemedView>

            <Pressable
              style={[styles.primaryButton, !safetyChecked && styles.disabledButton]}
              onPress={() => safetyChecked && setStep(2)}
              disabled={!safetyChecked}>
              <ThemedText style={styles.primaryButtonText}>Start calibration</ThemedText>
            </Pressable>
          </>
        );

      case 2:
        return (
          <>
            <ThemedText style={styles.wizardTitle}>
              Run {pumpId.toUpperCase()}
            </ThemedText>
            <ThemedText style={styles.bodyText}>
              Tap START to run the pump into the measuring cup. Tap STOP when you have a measurable volume.
            </ThemedText>

            {!isRunning ? (
              <Pressable
                style={styles.startButton}
                onPress={handleStart}>
                <ThemedText style={styles.startButtonText}>START</ThemedText>
              </Pressable>
            ) : (
              <Pressable style={styles.stopButton} onPress={handleStop}>
                <ThemedText style={styles.stopButtonText}>STOP</ThemedText>
              </Pressable>
            )}

            <ThemedText style={styles.metric}>
              Dispensed steps: {totalSteps}
            </ThemedText>
          </>
        );

      case 3:
        return (
          <>
            <ThemedText style={styles.wizardTitle}>
              Enter measured volume
            </ThemedText>
            <ThemedText style={styles.bodyText}>
              Pump ran {totalSteps.toLocaleString()} steps. Enter the volume that actually dispensed into the cup.
            </ThemedText>

            <ThemedText style={styles.label}>Measured volume (mL)</ThemedText>
            <ThemedTextInput
              style={styles.input}
              keyboardType="decimal-pad"
              placeholder="10.5"
              placeholderTextColor={Colors.slate}
              value={measuredMl}
              onChangeText={setMeasuredMl}
              autoFocus
            />

            {previewStepsPerMl !== null ? (
              <ThemedText style={styles.previewText}>
                Computed calibration: {previewStepsPerMl.toFixed(1)} steps/mL
              </ThemedText>
            ) : null}

            <ThemedView style={styles.buttonRow}>
              <Pressable style={styles.secondaryButton} onPress={() => setStep(2)}>
                <ThemedText style={styles.secondaryButtonText}>Back</ThemedText>
              </Pressable>
              <Pressable style={styles.primaryButton} onPress={handleSave}>
                <ThemedText style={styles.primaryButtonText}>Save calibration</ThemedText>
              </Pressable>
            </ThemedView>
          </>
        );

      case 4:
        return (
          <>
            <ThemedText style={styles.wizardTitle}>
              Calibration saved
            </ThemedText>
            <ThemedText style={styles.bodyText}>
              {pumpId.toUpperCase()} calibration updated.
            </ThemedText>

            <ThemedView style={styles.resultCard}>
              <ThemedView style={styles.resultRow}>
                <ThemedText style={styles.resultLabel}>Old</ThemedText>
                <ThemedText style={styles.resultValue}>
                  {result?.oldStepsPerMl?.toFixed(1) ?? '—'} steps/mL
                </ThemedText>
              </ThemedView>
              <ThemedView style={styles.resultRow}>
                <ThemedText style={styles.resultLabel}>New</ThemedText>
                <ThemedText style={styles.resultValue}>
                  {result?.newStepsPerMl.toFixed(1)} steps/mL
                </ThemedText>
              </ThemedView>
              <ThemedView style={styles.resultRow}>
                <ThemedText style={styles.resultLabel}>Measured</ThemedText>
                <ThemedText style={styles.resultValue}>
                  {result?.measuredMl.toFixed(2)} mL from {result?.totalSteps.toLocaleString()} steps
                </ThemedText>
              </ThemedView>
            </ThemedView>

            <Pressable style={styles.primaryButton} onPress={handleClose}>
              <ThemedText style={styles.primaryButtonText}>Done</ThemedText>
            </Pressable>
          </>
        );
    }
  })();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}>
      <ThemedView style={styles.modalOverlay}>
        <ThemedView style={styles.modalContent}>
          <ScrollView contentContainerStyle={styles.modalScroll}>
            {content}
            {error ? <ThemedText style={styles.errorText}>{error}</ThemedText> : null}
          </ScrollView>
        </ThemedView>
      </ThemedView>
    </Modal>
  );
}

export default function SettingsScreen() {
  const router = useRouter();
  const [baseUrl, setBaseUrlState] = useState('');
  const [savedUrl, setSavedUrl] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [status, setStatus] = useState<{
    pumps: { pumpId: PumpId; calibrated: boolean; stepsPerMl: number | null }[];
    queueDepth: number;
  } | null>(null);
  const [wizardPump, setWizardPump] = useState<PumpId | null>(null);
  const [message, setMessage] = useState('');
  const [primingPump, setPrimingPump] = useState<PumpId | null>(null);
  const [primeStartTime, setPrimeStartTime] = useState<number | null>(null);
  const [primeElapsedMs, setPrimeElapsedMs] = useState(0);
  const [primeResult, setPrimeResult] = useState<{
    pumpId: PumpId;
    totalSteps: number;
    approxMl: number | null;
  } | null>(null);
  const [primeError, setPrimeError] = useState('');
  const [primeState, setPrimeState] = useState<{
    priming: boolean;
    lastResult: PrimeResult | null;
  } | null>(null);
  const [primeWatchdogResult, setPrimeWatchdogResult] =
    useState<PrimeResult | null>(null);
  // Watchdog stops already surfaced (primeRunKey values) and start-confirmation
  // state live in refs: the reconciliation effect must read the latest values
  // without re-running on every local state change.
  const handledWatchdogKeysRef = useRef<ReadonlySet<string>>(new Set());
  const awaitingPrimeRef = useRef(false);

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      getDeviceBaseUrl().then((url) => {
        if (mounted) {
          const effective = resolveDeviceBaseUrl(url);
          setSavedUrl(effective);
          setBaseUrlState(effective);
        }
      });
      return () => {
        mounted = false;
      };
    }, []),
  );

  const load = useCallback(async () => {
    if (!savedUrl) return;
    try {
      const data = await getStatus(savedUrl);
      setOffline(false);
      setStatus({
        pumps: data?.pumps?.map((p) => ({
          pumpId: p.pumpId,
          calibrated: p.calibrated,
          stepsPerMl: p.stepsPerMl,
        })) ?? [],
        queueDepth: data?.queueDepth ?? 0,
      });
      setPrimeState(data?.prime ?? null);
    } catch {
      setOffline(true);
      setStatus(null);
    }
  }, [savedUrl]);

  useFocusEffect(
    useCallback(() => {
      load();
      const interval = setInterval(load, 10_000);
      return () => clearInterval(interval);
    }, [load]),
  );

  const handleSave = async () => {
    try {
      await setDeviceBaseUrl(baseUrl.trim());
      setSavedUrl(baseUrl.trim());
      setMessage('Saved');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed');
    }
  };

  const handleReset = async () => {
    await clearDeviceBaseUrl();
    setSavedUrl(null);
    setBaseUrlState('');
    setMessage('Cleared');
    router.replace('/');
  };

  // Prime elapsed-time ticker.
  useFocusEffect(
    useCallback(() => {
      if (!primeStartTime) return;
      const interval = setInterval(() => {
        setPrimeElapsedMs(Date.now() - primeStartTime);
      }, 250);
      return () => clearInterval(interval);
    }, [primeStartTime]),
  );

  const pumpsById = useMemo(() => {
    const map = new Map<PumpId, { calibrated: boolean; stepsPerMl: number | null }>();
    for (const p of status?.pumps ?? []) {
      map.set(p.pumpId, p);
    }
    return map;
  }, [status]);

  const handlePrimeStart = async (pumpId: PumpId) => {
    if (!savedUrl) return;
    setPrimeError('');
    setPrimeResult(null);
    try {
      await startPrime(savedUrl, { pumpId });
      // Ignore pre-start polls until a poll confirms the device sees the
      // run — they can report a stale "not priming".
      awaitingPrimeRef.current = true;
      setPrimingPump(pumpId);
      setPrimeStartTime(Date.now());
      setPrimeElapsedMs(0);
    } catch (err) {
      setPrimeError(err instanceof Error ? err.message : 'Failed to start prime');
    }
  };

  const handlePrimeStop = async () => {
    if (!savedUrl || !primingPump) return;
    setPrimeError('');
    try {
      const res = await stopPrime(savedUrl, { pumpId: primingPump });
      awaitingPrimeRef.current = false;
      setPrimingPump(null);
      setPrimeStartTime(null);
      setPrimeResult(res);
    } catch (err) {
      if (isPrimeGoneError(err)) {
        // The session already ended on the device (watchdog or restart).
        // The device owns all stopping — reconcile from its state instead
        // of showing "No prime running" as an error.
        awaitingPrimeRef.current = false;
        await reconcilePrimeFromDevice();
        return;
      }
      awaitingPrimeRef.current = false;
      setPrimingPump(null);
      setPrimeStartTime(null);
      setPrimeError(err instanceof Error ? err.message : 'Failed to stop prime');
    }
  };

  // Fetch the device's prime state and fold it into reconciliation. Used
  // after a 409 from stopPrime; the regular status poll funnels through the
  // same effect below, so both paths share one dedupe guard.
  const reconcilePrimeFromDevice = async () => {
    if (!savedUrl) return;
    try {
      const data = await getStatus(savedUrl);
      setOffline(false);
      const prime = data?.prime ?? null;
      setPrimeState(prime);
      if (!prime) {
        setPrimingPump(null);
        setPrimeStartTime(null);
        return;
      }
      const outcome = reconcileAfterPrimeGone({
        localPriming: true,
        lastResult: prime.lastResult,
        handledKeys: handledWatchdogKeysRef.current,
      });
      handledWatchdogKeysRef.current = outcome.handledKeys;
      if (outcome.clearLocalPrime) {
        setPrimingPump(null);
        setPrimeStartTime(null);
      }
      if (outcome.showWatchdogModal) {
        setPrimeWatchdogResult(outcome.showWatchdogModal);
      }
    } catch {
      setOffline(true);
      setPrimingPump(null);
      setPrimeStartTime(null);
    }
  };

  // The 10 s status poll is the single source of truth for prime state while
  // a prime is active. On any "device reports no prime" (even detected late
  // after the phone was asleep), clear the local countdown — the local
  // timer never initiates a stop — and surface the paused modal when the
  // run ended on the watchdog.
  useEffect(() => {
    if (!primeState) return;
    const outcome = reconcilePrime({
      localPriming: primingPump !== null,
      devicePriming: primeState.priming,
      lastResult: primeState.lastResult,
      handledKeys: handledWatchdogKeysRef.current,
      awaitingConfirmation: awaitingPrimeRef.current,
    });
    awaitingPrimeRef.current = outcome.awaitingConfirmation;
    handledWatchdogKeysRef.current = outcome.handledKeys;
    if (outcome.clearLocalPrime) {
      setPrimingPump(null);
      setPrimeStartTime(null);
    }
    if (outcome.showWatchdogModal) {
      setPrimeWatchdogResult(outcome.showWatchdogModal);
    }
  }, [primeState, primingPump]);

  const handlePrimeAgain = async () => {
    const result = primeWatchdogResult;
    setPrimeWatchdogResult(null);
    if (result) {
      await handlePrimeStart(result.pumpId);
    }
  };

  const handlePrimeWatchdogDone = () => {
    setPrimeWatchdogResult(null);
  };

  const formatElapsed = (ms: number): string => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  return (
    <ThemedView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <ThemedText style={styles.header}>Settings</ThemedText>
        {offline && <OfflineCard onRetry={() => load()} />}

        <ThemedView style={styles.card}>
          <ThemedText style={styles.label}>Reef Doser device URL</ThemedText>
          <ThemedTextInput
            style={styles.input}
            value={baseUrl}
            onChangeText={setBaseUrlState}
            placeholder="http://192.168.0.33:8000"
            placeholderTextColor={Colors.slate}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <Pressable style={styles.button} onPress={handleSave}>
            <ThemedText style={styles.buttonText}>Save Device URL</ThemedText>
          </Pressable>
          {message ? <ThemedText style={styles.message}>{message}</ThemedText> : null}
        </ThemedView>

        <ThemedView style={styles.card}>
          <ThemedText style={styles.label}>Calibration</ThemedText>
          {status && status.queueDepth > 0 && (
            <ThemedView style={styles.queueWarning}>
              <ThemedText style={styles.queueWarningText}>
                Dose in progress — calibration is blocked until the queue is clear.
              </ThemedText>
            </ThemedView>
          )}
          {PUMP_ORDER.map((id) => {
            const pump = pumpsById.get(id);
            return (
              <ThemedView key={id} style={styles.pumpRow}>
                <ThemedView style={styles.pumpInfo}>
                  <ThemedText style={styles.pumpTitle}>{id}</ThemedText>
                  <ThemedText style={styles.pumpMetric}>
                    {pump?.calibrated
                      ? `${pump.stepsPerMl?.toFixed(1)} steps/mL`
                      : 'Not calibrated'}
                  </ThemedText>
                </ThemedView>
                <Pressable
                  style={[
                    styles.calButton,
                    status && status.queueDepth > 0 && styles.disabledButton,
                  ]}
                  onPress={() => setWizardPump(id)}
                  disabled={status ? status.queueDepth > 0 : false}>
                  <ThemedText style={styles.calButtonText}>Calibrate</ThemedText>
                </Pressable>
              </ThemedView>
            );
          })}
        </ThemedView>

        <ThemedView style={styles.card}>
          <ThemedText style={styles.label}>Prime lines</ThemedText>
          {status && status.queueDepth > 0 && (
            <ThemedView style={styles.queueWarning}>
              <ThemedText style={styles.queueWarningText}>
                Dose in progress — priming is blocked until the queue is clear.
              </ThemedText>
            </ThemedView>
          )}
          {primeError ? (
            <ThemedText style={styles.errorText}>{primeError}</ThemedText>
          ) : null}
          {primeResult ? (
            <ThemedView style={styles.resultCard}>
              <ThemedText style={styles.bodyText}>
                Primed {primeResult.pumpId.toUpperCase()}:{' '}
                {primeResult.totalSteps.toLocaleString()} steps
                {primeResult.approxMl !== null
                  ? ` (~${primeResult.approxMl.toFixed(2)} mL)`
                  : ' (pump uncalibrated)'}
              </ThemedText>
            </ThemedView>
          ) : null}
          {PUMP_ORDER.map((id) => {
            const isThisPriming = primingPump === id;
            const blocked =
              (status && status.queueDepth > 0) ||
              primingPump !== null;
            return (
              <ThemedView key={id} style={styles.pumpRow}>
                <ThemedView style={styles.pumpInfo}>
                  <ThemedText style={styles.pumpTitle}>{id}</ThemedText>
                  {isThisPriming ? (
                    <ThemedText style={styles.pumpMetric}>
                      Running: {formatElapsed(primeElapsedMs)}
                    </ThemedText>
                  ) : (
                    <ThemedText style={styles.pumpMetric}>
                      {pumpsById.get(id)?.calibrated
                        ? `${pumpsById.get(id)?.stepsPerMl?.toFixed(1)} steps/mL`
                        : 'Not calibrated'}
                    </ThemedText>
                  )}
                </ThemedView>
                {isThisPriming ? (
                  <Pressable style={styles.stopButton} onPress={handlePrimeStop}>
                    <ThemedText style={styles.stopButtonText}>STOP</ThemedText>
                  </Pressable>
                ) : (
                  <Pressable
                    style={[
                      styles.primeButton,
                      blocked && styles.disabledButton,
                    ]}
                    onPress={() => !blocked && handlePrimeStart(id)}
                    disabled={blocked}>
                    <ThemedText style={styles.primeButtonText}>Prime</ThemedText>
                  </Pressable>
                )}
              </ThemedView>
            );
          })}
        </ThemedView>

        <ThemedView style={styles.card}>
          <ThemedText style={styles.label}>Connection</ThemedText>
          <ThemedText style={styles.metric}>
            Saved URL: {savedUrl ?? 'none'}
          </ThemedText>
          <Pressable style={styles.resetButton} onPress={handleReset}>
            <ThemedText style={styles.resetText}>Change Device URL</ThemedText>
          </Pressable>
        </ThemedView>

        <ThemedView style={styles.infoCard}>
          <ThemedText style={styles.label}>SHARLAY Dose v1.0</ThemedText>
          <ThemedText style={styles.metric}>
            Smart Dosing. Stable Results.
          </ThemedText>
        </ThemedView>
      </ScrollView>

      {wizardPump && (
        <CalibrationWizard
          pumpId={wizardPump}
          oldStepsPerMl={pumpsById.get(wizardPump)?.stepsPerMl ?? null}
          queueDepth={status?.queueDepth ?? 0}
          visible={wizardPump !== null}
          onClose={() => setWizardPump(null)}
        />
      )}

      <Modal
        visible={primeWatchdogResult !== null}
        transparent
        animationType="fade"
        onRequestClose={handlePrimeWatchdogDone}>
        <ThemedView style={styles.watchdogOverlay}>
          <ThemedView style={styles.watchdogCard}>
            <ThemedText style={styles.wizardTitle}>Priming paused</ThemedText>
            <ThemedText style={styles.bodyText}>
              The pump ran for its full time limit and stopped automatically as
              a safety measure. It moved approx.{' '}
              {primeWatchdogResult?.approxMl != null
                ? `${primeWatchdogResult.approxMl.toFixed(1)} mL`
                : '— (pump uncalibrated)'}
              . If the tube isn't fully primed yet, you can run it again.
            </ThemedText>
            <ThemedView style={styles.buttonRow}>
              <Pressable
                style={styles.secondaryButton}
                onPress={handlePrimeWatchdogDone}>
                <ThemedText style={styles.secondaryButtonText}>Done</ThemedText>
              </Pressable>
              <Pressable
                style={styles.primeAgainButton}
                onPress={handlePrimeAgain}>
                <ThemedText style={styles.primeAgainButtonText}>
                  Prime again
                </ThemedText>
              </Pressable>
            </ThemedView>
          </ThemedView>
        </ThemedView>
      </Modal>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.obsidian,
  },
  scroll: {
    padding: Spacing.md,
    paddingBottom: Spacing.xl,
  },
  header: {
    ...Typography.h1,
    color: Colors.pearl,
    marginBottom: Spacing.md,
  },
  card: {
    backgroundColor: Colors.abyss,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  label: {
    ...Typography.body,
    color: Colors.pearl,
    marginBottom: Spacing.md,
  },
  input: {
    height: 48,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: 'rgba(32, 227, 216, 0.3)',
    backgroundColor: Colors.midnight,
    color: Colors.pearl,
    paddingHorizontal: Spacing.md,
    fontSize: Typography.body.fontSize,
    marginBottom: Spacing.md,
  },
  button: {
    height: 56,
    borderRadius: Radius.sm,
    backgroundColor: Colors.blue,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    ...Typography.title,
    color: Colors.pearl,
  },
  message: {
    ...Typography.small,
    color: Colors.titanium,
    marginTop: Spacing.sm,
  },
  metric: {
    ...Typography.body,
    color: Colors.titanium,
    marginBottom: Spacing.md,
  },
  resetButton: {
    height: 48,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: Colors.aqua,
    alignItems: 'center',
    justifyContent: 'center',
  },
  resetText: {
    ...Typography.body,
    color: Colors.aqua,
  },
  infoCard: {
    backgroundColor: Colors.abyss,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginTop: 'auto',
  },
  queueWarning: {
    backgroundColor: Colors.danger,
    borderRadius: Radius.sm,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  queueWarningText: {
    ...Typography.small,
    color: Colors.pearl,
  },
  pumpRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.midnight,
  },
  pumpInfo: {
    flex: 1,
  },
  pumpTitle: {
    ...Typography.h3,
    color: Colors.pearl,
    textTransform: 'uppercase',
  },
  pumpMetric: {
    ...Typography.small,
    color: Colors.titanium,
  },
  calButton: {
    backgroundColor: Colors.aqua,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.sm,
  },
  calButtonText: {
    ...Typography.body,
    color: Colors.obsidian,
    fontWeight: '600',
  },
  primeButton: {
    backgroundColor: Colors.warning,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.sm,
  },
  primeButtonText: {
    ...Typography.body,
    color: Colors.obsidian,
    fontWeight: '600',
  },
  disabledButton: {
    opacity: 0.4,
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.7)',
  },
  modalContent: {
    maxHeight: '90%',
    backgroundColor: Colors.abyss,
    borderTopLeftRadius: Radius.lg,
    borderTopRightRadius: Radius.lg,
    padding: Spacing.lg,
    paddingBottom: Spacing.xxl,
  },
  modalScroll: {
    gap: Spacing.md,
  },
  wizardTitle: {
    ...Typography.h2,
    color: Colors.pearl,
  },
  wizardSubtitle: {
    ...Typography.body,
    color: Colors.titanium,
  },
  warningCard: {
    backgroundColor: Colors.midnight,
    borderRadius: Radius.md,
    padding: Spacing.md,
    borderLeftWidth: 4,
    borderLeftColor: Colors.warning,
  },
  warningHeading: {
    ...Typography.title,
    color: Colors.warning,
    marginBottom: Spacing.sm,
  },
  bodyText: {
    ...Typography.body,
    color: Colors.titanium,
    marginBottom: Spacing.sm,
  },
  warningText: {
    ...Typography.body,
    color: Colors.danger,
    marginBottom: Spacing.md,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  startButton: {
    height: 96,
    borderRadius: Radius.md,
    backgroundColor: Colors.success,
    alignItems: 'center',
    justifyContent: 'center',
  },
  startButtonText: {
    ...Typography.h2,
    color: Colors.obsidian,
  },
  stopButton: {
    height: 96,
    borderRadius: Radius.md,
    backgroundColor: Colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopButtonText: {
    ...Typography.h2,
    color: Colors.pearl,
  },
  primaryButton: {
    height: 56,
    borderRadius: Radius.sm,
    backgroundColor: Colors.blue,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    ...Typography.title,
    color: Colors.pearl,
  },
  secondaryButton: {
    flex: 1,
    height: 56,
    borderRadius: Radius.sm,
    backgroundColor: Colors.midnight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: {
    ...Typography.title,
    color: Colors.pearl,
  },
  primeAgainButton: {
    flex: 1,
    height: 56,
    borderRadius: Radius.sm,
    backgroundColor: Colors.aqua,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primeAgainButtonText: {
    ...Typography.title,
    color: Colors.obsidian,
    fontWeight: '600',
  },
  watchdogOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(7, 10, 18, 0.8)',
    padding: Spacing.lg,
  },
  watchdogCard: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: 'rgba(17, 24, 39, 0.92)',
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: 'rgba(32, 227, 219, 0.15)',
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: Spacing.md,
  },
  previewText: {
    ...Typography.body,
    color: Colors.aqua,
  },
  resultCard: {
    backgroundColor: Colors.midnight,
    borderRadius: Radius.md,
    padding: Spacing.md,
  },
  resultRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: Spacing.sm,
  },
  resultLabel: {
    ...Typography.body,
    color: Colors.titanium,
  },
  resultValue: {
    ...Typography.body,
    color: Colors.pearl,
  },
  errorText: {
    ...Typography.body,
    color: Colors.danger,
    textAlign: 'center',
  },
});
