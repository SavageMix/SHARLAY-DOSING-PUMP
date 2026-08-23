import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Switch,
  TextInput,
  View,
} from 'react-native';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useFocusEffect } from 'expo-router';

import { ThemedText } from '@/components/ThemedText';
import { ThemedTextInput, ThemedView } from '@/components/Themed';
import {
  createSchedule,
  deleteSchedule,
  getDeviceBaseUrl,
  getSchedules,
  updateSchedule,
  type DoseSchedule,
} from '@/src/api/client';
import { Colors, Radius, Spacing, Typography } from '@/constants/Theme';
import {
  formatScheduleSummary,
  type PumpId,
} from '@reef/shared';

const PUMP_ORDER: PumpId[] = ['alk', 'ca', 'no3', 'po4'];

interface FormState {
  pumpId: PumpId;
  volumeMl: string;
  timesPerDay: string;
  startTime: string;
  repeatEveryNDays: string;
  enabled: boolean;
}

function emptyForm(): FormState {
  return {
    pumpId: 'alk',
    volumeMl: '',
    timesPerDay: '1',
    startTime: '06:00',
    repeatEveryNDays: '1',
    enabled: true,
  };
}

function scheduleToForm(schedule: DoseSchedule): FormState {
  return {
    pumpId: schedule.pumpId,
    volumeMl: schedule.volumeMl.toString(),
    timesPerDay: schedule.timesPerDay.toString(),
    startTime: schedule.startTime,
    repeatEveryNDays: schedule.repeatEveryNDays.toString(),
    enabled: schedule.enabled,
  };
}

function parseForm(form: FormState): { valid: true; data: Omit<DoseSchedule, 'id' | 'lastRunAt'> } | { valid: false; error: string } {
  const volumeMl = parseFloat(form.volumeMl);
  if (Number.isNaN(volumeMl) || volumeMl <= 0) {
    return { valid: false, error: 'Enter a positive volume' };
  }
  const timesPerDay = parseInt(form.timesPerDay, 10);
  if (Number.isNaN(timesPerDay) || timesPerDay < 1 || timesPerDay > 24) {
    return { valid: false, error: 'Times per day must be 1–24' };
  }
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(form.startTime)) {
    return { valid: false, error: 'Start time must be HH:mm' };
  }
  const repeatEveryNDays = parseInt(form.repeatEveryNDays, 10);
  if (Number.isNaN(repeatEveryNDays) || repeatEveryNDays < 1 || repeatEveryNDays > 7) {
    return { valid: false, error: 'Repeat interval must be 1–7 days' };
  }
  return {
    valid: true,
    data: {
      pumpId: form.pumpId,
      volumeMl,
      timesPerDay,
      startTime: form.startTime,
      repeatEveryNDays,
      enabled: form.enabled,
    },
  };
}

interface ScheduleItemProps {
  schedule: DoseSchedule;
  onEdit: (schedule: DoseSchedule) => void;
  onDelete: (schedule: DoseSchedule) => void;
}

function ScheduleItem({ schedule, onEdit, onDelete }: ScheduleItemProps) {
  const translateX = useState(new Animated.Value(0))[0];
  const [confirming, setConfirming] = useState(false);

  const panResponder = useState(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) =>
          Math.abs(gesture.dx) > 10,
        onPanResponderMove: (_, gesture) => {
          translateX.setValue(Math.min(0, Math.max(-120, gesture.dx)));
        },
        onPanResponderRelease: (_, gesture) => {
          if (gesture.dx < -60) {
            Animated.spring(translateX, {
              toValue: -100,
              useNativeDriver: true,
            }).start();
            setConfirming(true);
          } else {
            Animated.spring(translateX, {
              toValue: 0,
              useNativeDriver: true,
            }).start();
            setConfirming(false);
          }
        },
      }),
  )[0];

  const handleConfirmDelete = () => {
    Animated.timing(translateX, {
      toValue: 0,
      duration: 200,
      useNativeDriver: true,
    }).start(() => onDelete(schedule));
  };

  const handleCancelDelete = () => {
    Animated.spring(translateX, {
      toValue: 0,
      useNativeDriver: true,
    }).start();
    setConfirming(false);
  };

  return (
    <View style={styles.swipeContainer}>
      <View style={styles.deleteBackground}>
        {confirming ? (
          <Pressable onPress={handleConfirmDelete} style={styles.deleteConfirmButton}>
            <ThemedText style={styles.deleteConfirmText}>Tap again to delete</ThemedText>
          </Pressable>
        ) : (
          <Pressable onPress={handleConfirmDelete} style={styles.deleteConfirmButton}>
            <ThemedText style={styles.deleteConfirmText}>Delete</ThemedText>
          </Pressable>
        )}
      </View>
      <Animated.View
        style={[styles.scheduleRow, { transform: [{ translateX }] }]}
        {...panResponder.panHandlers}>
        <Pressable
          onPress={() => {
            if (confirming) {
              handleCancelDelete();
            } else {
              onEdit(schedule);
            }
          }}
          style={styles.scheduleCard}
          android_ripple={{ color: Colors.aqua }}>
          <ThemedView style={styles.row}>
            <ThemedText style={styles.pumpTitle}>{schedule.pumpId}</ThemedText>
            <ThemedText
              style={[
                styles.badge,
                schedule.enabled ? styles.success : styles.warning,
              ]}>
              {schedule.enabled ? 'enabled' : 'disabled'}
            </ThemedText>
          </ThemedView>
          <ThemedText style={styles.summary}>{formatScheduleSummary(schedule)}</ThemedText>
          {schedule.lastRunAt ? (
            <ThemedText style={styles.metric}>
              Last run: {new Date(schedule.lastRunAt).toLocaleString()}
            </ThemedText>
          ) : null}
        </Pressable>
      </Animated.View>
    </View>
  );
}

interface EditorModalProps {
  visible: boolean;
  editingId: string | null;
  form: FormState;
  onClose: () => void;
  onChange: (form: FormState) => void;
  onSave: () => void;
  summary: string;
}

function EditorModal({
  visible,
  editingId,
  form,
  onClose,
  onChange,
  onSave,
  summary,
}: EditorModalProps) {
  const [showTimePicker, setShowTimePicker] = useState(false);

  const startDate = useMemo(() => {
    const [h, m] = form.startTime.split(':').map((p) => parseInt(p, 10));
    const d = new Date();
    d.setHours(h ?? 6, m ?? 0, 0, 0);
    return d;
  }, [form.startTime]);

  const onTimeChange = (_: DateTimePickerEvent, date?: Date) => {
    setShowTimePicker(false);
    if (date) {
      const h = date.getHours().toString().padStart(2, '0');
      const m = date.getMinutes().toString().padStart(2, '0');
      onChange({ ...form, startTime: `${h}:${m}` });
    }
  };

  const updateNumber = (field: keyof FormState, text: string) => {
    // Allow only digits for numeric fields
    if (/^\d*$/.test(text)) {
      onChange({ ...form, [field]: text } as FormState);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      presentationStyle="overFullScreen"
      onRequestClose={onClose}>
      <ThemedView style={styles.modalOverlay}>
        <ThemedView style={styles.modalContent}>
          <ThemedText style={styles.modalHeader}>
            {editingId ? 'Edit Schedule' : 'New Schedule'}
          </ThemedText>

          <ThemedView style={styles.pumpRow}>
            {PUMP_ORDER.map((id) => (
              <Pressable
                key={id}
                style={[
                  styles.pumpChip,
                  form.pumpId === id && styles.pumpChipActive,
                ]}
                onPress={() => onChange({ ...form, pumpId: id })}>
                <ThemedText
                  style={[
                    styles.chipText,
                    form.pumpId === id && styles.chipTextActive,
                  ]}>
                  {id}
                </ThemedText>
              </Pressable>
            ))}
          </ThemedView>

          <ThemedText style={styles.label}>Amount (mL)</ThemedText>
          <ThemedTextInput
            style={styles.input}
            keyboardType="decimal-pad"
            placeholder="10"
            placeholderTextColor={Colors.slate}
            value={form.volumeMl}
            onChangeText={(text) => onChange({ ...form, volumeMl: text })}
          />

          <ThemedText style={styles.label}>Times per day (1–24)</ThemedText>
          <ThemedTextInput
            style={styles.input}
            keyboardType="number-pad"
            placeholder="1"
            placeholderTextColor={Colors.slate}
            value={form.timesPerDay}
            onChangeText={(text) => updateNumber('timesPerDay', text)}
          />

          <ThemedText style={styles.label}>Start time</ThemedText>
          <Pressable
            style={styles.timeButton}
            onPress={() => setShowTimePicker(true)}>
            <ThemedText style={styles.timeButtonText}>{form.startTime}</ThemedText>
          </Pressable>
          {showTimePicker && (
            <DateTimePicker
              value={startDate}
              mode="time"
              is24Hour
              display="default"
              onChange={onTimeChange}
            />
          )}

          <ThemedText style={styles.label}>Repeat every N days (1–7)</ThemedText>
          <ThemedTextInput
            style={styles.input}
            keyboardType="number-pad"
            placeholder="1"
            placeholderTextColor={Colors.slate}
            value={form.repeatEveryNDays}
            onChangeText={(text) => updateNumber('repeatEveryNDays', text)}
          />

          <ThemedView style={styles.toggleRow}>
            <ThemedText style={styles.label}>Enabled</ThemedText>
            <Switch
              value={form.enabled}
              onValueChange={(value) => onChange({ ...form, enabled: value })}
              trackColor={{ false: Colors.slate, true: Colors.aqua }}
              thumbColor={form.enabled ? Colors.pearl : Colors.titanium}
            />
          </ThemedView>

          <ThemedView style={styles.summaryCard}>
            <ThemedText style={styles.summaryLabel}>Summary</ThemedText>
            <ThemedText style={styles.summaryText}>{summary}</ThemedText>
          </ThemedView>

          <ThemedView style={styles.modalButtons}>
            <Pressable style={[styles.modalButton, styles.cancelButton]} onPress={onClose}>
              <ThemedText style={styles.cancelButtonText}>Cancel</ThemedText>
            </Pressable>
            <Pressable style={[styles.modalButton, styles.saveButton]} onPress={onSave}>
              <ThemedText style={styles.saveButtonText}>
                {editingId ? 'Update' : 'Create'}
              </ThemedText>
            </Pressable>
          </ThemedView>
        </ThemedView>
      </ThemedView>
    </Modal>
  );
}

export default function SchedulesScreen() {
  const [schedules, setSchedules] = useState<DoseSchedule[]>([]);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [message, setMessage] = useState('');

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      getDeviceBaseUrl().then((url) => {
        if (mounted) setBaseUrl(url);
      });
      return () => { mounted = false; };
    }, []),
  );

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      async function load() {
        if (!baseUrl) return;
        try {
          setLoading(true);
          const data = await getSchedules(baseUrl);
          if (mounted) setSchedules(data.schedules);
        } finally {
          if (mounted) setLoading(false);
        }
      }
      load();
      return () => { mounted = false; };
    }, [baseUrl]),
  );

  const grouped = useMemo(() => {
    const map = new Map<PumpId, DoseSchedule[]>();
    for (const pumpId of PUMP_ORDER) {
      map.set(pumpId, []);
    }
    for (const schedule of schedules) {
      map.get(schedule.pumpId)?.push(schedule);
    }
    return Array.from(map.entries());
  }, [schedules]);

  const summary = useMemo(() => {
    const parsed = parseForm(form);
    if (!parsed.valid) return parsed.error;
    return formatScheduleSummary(parsed.data);
  }, [form]);

  const openNew = () => {
    setEditingId(null);
    setForm(emptyForm());
    setModalVisible(true);
  };

  const openEdit = (schedule: DoseSchedule) => {
    setEditingId(schedule.id);
    setForm(scheduleToForm(schedule));
    setModalVisible(true);
  };

  const handleSave = async () => {
    if (!baseUrl) return;
    const parsed = parseForm(form);
    if (!parsed.valid) {
      setMessage(parsed.error);
      return;
    }
    try {
      if (editingId) {
        await updateSchedule(baseUrl, editingId, parsed.data);
        setMessage('Schedule updated');
      } else {
        await createSchedule(baseUrl, parsed.data);
        setMessage('Schedule created');
      }
      setModalVisible(false);
      const data = await getSchedules(baseUrl);
      setSchedules(data.schedules);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed');
    }
  };

  const handleDelete = (schedule: DoseSchedule) => {
    if (!baseUrl) return;
    Alert.alert(
      'Delete schedule',
      `Delete schedule for ${schedule.pumpId}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteSchedule(baseUrl, schedule.id);
              setMessage('Schedule deleted');
              const data = await getSchedules(baseUrl);
              setSchedules(data.schedules);
            } catch (err) {
              setMessage(err instanceof Error ? err.message : 'Failed');
            }
          },
        },
      ],
    );
  };

  if (!baseUrl) {
    return (
      <ThemedView style={styles.centered}>
        <ThemedText>No device URL configured.</ThemedText>
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.container}>
      <ThemedView style={styles.headerRow}>
        <ThemedText style={styles.header}>Schedules</ThemedText>
        <Pressable style={styles.addButton} onPress={openNew}>
          <ThemedText style={styles.addButtonText}>+ Add</ThemedText>
        </Pressable>
      </ThemedView>

      {loading && <ActivityIndicator color={Colors.aqua} style={styles.loader} />}

      <FlatList
        data={grouped}
        keyExtractor={([pumpId]) => pumpId}
        contentContainerStyle={styles.list}
        renderItem={({ item: [pumpId, items] }) => (
          <ThemedView style={styles.group}>
            <ThemedText style={styles.groupTitle}>{pumpId}</ThemedText>
            {items.length === 0 ? (
              <ThemedText style={styles.emptyText}>No schedules</ThemedText>
            ) : (
              items.map((schedule) => (
                <ScheduleItem
                  key={schedule.id}
                  schedule={schedule}
                  onEdit={openEdit}
                  onDelete={handleDelete}
                />
              ))
            )}
          </ThemedView>
        )}
      />

      {message ? <ThemedText style={styles.message}>{message}</ThemedText> : null}

      <EditorModal
        visible={modalVisible}
        editingId={editingId}
        form={form}
        onClose={() => setModalVisible(false)}
        onChange={setForm}
        onSave={handleSave}
        summary={summary}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: Spacing.md,
    backgroundColor: Colors.obsidian,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.md,
  },
  header: {
    ...Typography.h1,
    color: Colors.pearl,
  },
  addButton: {
    backgroundColor: Colors.blue,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.sm,
  },
  addButtonText: {
    ...Typography.title,
    color: Colors.pearl,
  },
  loader: {
    marginVertical: Spacing.md,
  },
  list: {
    paddingBottom: Spacing.xl,
  },
  group: {
    marginBottom: Spacing.lg,
  },
  groupTitle: {
    ...Typography.h2,
    color: Colors.aqua,
    textTransform: 'uppercase',
    marginBottom: Spacing.sm,
  },
  emptyText: {
    ...Typography.body,
    color: Colors.slate,
    marginBottom: Spacing.sm,
  },
  swipeContainer: {
    position: 'relative',
    marginBottom: Spacing.md,
    borderRadius: Radius.md,
    overflow: 'hidden',
  },
  deleteBackground: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Colors.danger,
    justifyContent: 'center',
    alignItems: 'flex-end',
    paddingRight: Spacing.md,
    borderRadius: Radius.md,
  },
  deleteConfirmButton: {
    padding: Spacing.md,
  },
  deleteConfirmText: {
    ...Typography.title,
    color: Colors.pearl,
  },
  scheduleRow: {
    borderRadius: Radius.md,
  },
  scheduleCard: {
    backgroundColor: Colors.abyss,
    borderRadius: Radius.md,
    padding: Spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.sm,
  },
  pumpTitle: {
    ...Typography.h3,
    color: Colors.pearl,
    textTransform: 'uppercase',
  },
  badge: {
    ...Typography.caption,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    borderRadius: Radius.sm,
    overflow: 'hidden',
  },
  success: {
    backgroundColor: Colors.success,
    color: Colors.obsidian,
  },
  warning: {
    backgroundColor: Colors.warning,
    color: Colors.obsidian,
  },
  summary: {
    ...Typography.body,
    color: Colors.titanium,
    marginBottom: Spacing.xs,
  },
  metric: {
    ...Typography.small,
    color: Colors.slate,
  },
  message: {
    ...Typography.small,
    color: Colors.titanium,
    marginTop: Spacing.sm,
    textAlign: 'center',
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  modalContent: {
    backgroundColor: Colors.abyss,
    borderTopLeftRadius: Radius.lg,
    borderTopRightRadius: Radius.lg,
    padding: Spacing.lg,
    paddingBottom: Spacing.xxl,
  },
  modalHeader: {
    ...Typography.h2,
    color: Colors.pearl,
    marginBottom: Spacing.md,
  },
  pumpRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  pumpChip: {
    flex: 1,
    height: 44,
    borderRadius: Radius.sm,
    backgroundColor: Colors.midnight,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  pumpChipActive: {
    borderColor: Colors.aqua,
  },
  chipText: {
    ...Typography.body,
    color: Colors.titanium,
    textTransform: 'uppercase',
  },
  chipTextActive: {
    color: Colors.aqua,
  },
  label: {
    ...Typography.small,
    color: Colors.titanium,
    marginBottom: Spacing.xs,
    marginTop: Spacing.sm,
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
  },
  timeButton: {
    height: 48,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: 'rgba(32, 227, 216, 0.3)',
    backgroundColor: Colors.midnight,
    justifyContent: 'center',
    paddingHorizontal: Spacing.md,
  },
  timeButtonText: {
    ...Typography.body,
    color: Colors.pearl,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: Spacing.sm,
  },
  summaryCard: {
    backgroundColor: Colors.midnight,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginTop: Spacing.md,
  },
  summaryLabel: {
    ...Typography.small,
    color: Colors.slate,
    marginBottom: Spacing.xs,
  },
  summaryText: {
    ...Typography.body,
    color: Colors.pearl,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: Spacing.md,
    marginTop: Spacing.lg,
  },
  modalButton: {
    flex: 1,
    height: 56,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelButton: {
    backgroundColor: Colors.midnight,
  },
  cancelButtonText: {
    ...Typography.title,
    color: Colors.pearl,
  },
  saveButton: {
    backgroundColor: Colors.blue,
  },
  saveButtonText: {
    ...Typography.title,
    color: Colors.pearl,
  },
});
