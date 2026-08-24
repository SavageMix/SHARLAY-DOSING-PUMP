import { useCallback, useMemo, useState } from 'react';
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

import { ThemedText } from '@/components/ThemedText';
import { ThemedTextInput, ThemedView } from '@/components/Themed';
import {
  clearDeviceBaseUrl,
  getDeviceBaseUrl,
  getStatus,
  saveCalibration,
  setDeviceBaseUrl,
  startCalibration,
  stopCalibration,
} from '@/src/api/client';
import { Colors, Radius, Spacing, Typography } from '@/constants/Theme';
import { type PumpId } from '@reef/shared';

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
        if (mounted) setBaseUrl(url);
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
  const [status, setStatus] = useState<{
    pumps: { pumpId: PumpId; calibrated: boolean; stepsPerMl: number | null }[];
    queueDepth: number;
  } | null>(null);
  const [wizardPump, setWizardPump] = useState<PumpId | null>(null);
  const [message, setMessage] = useState('');

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      getDeviceBaseUrl().then((url) => {
        if (mounted) {
          setSavedUrl(url);
          setBaseUrlState(url ?? '');
        }
      });
      return () => {
        mounted = false;
      };
    }, []),
  );

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      async function load() {
        if (!savedUrl) return;
        try {
          const data = await getStatus(savedUrl);
          if (mounted) {
            setStatus({
              pumps: data.pumps.map((p) => ({
                pumpId: p.pumpId,
                calibrated: p.calibrated,
                stepsPerMl: p.stepsPerMl,
              })),
              queueDepth: data.queueDepth,
            });
          }
        } catch {
          if (mounted) setStatus(null);
        }
      }
      load();
      const interval = setInterval(load, 10_000);
      return () => {
        mounted = false;
        clearInterval(interval);
      };
    }, [savedUrl]),
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

  const pumpsById = useMemo(() => {
    const map = new Map<PumpId, { calibrated: boolean; stepsPerMl: number | null }>();
    for (const p of status?.pumps ?? []) {
      map.set(p.pumpId, p);
    }
    return map;
  }, [status]);

  return (
    <ThemedView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <ThemedText style={styles.header}>Settings</ThemedText>

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
