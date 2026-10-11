import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Dimensions,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { render, screen } from '@testing-library/react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { resetAllMocks, setDimensions } from 'vitest-native/helpers';
import type { DoseSchedule } from '@reef/shared';

import { NextDoseCard } from './NextDoseCard';
import type { NextDose } from '@/src/lib/next-dose';

// Decorative icon font — no native font loading in the test runtime.
vi.mock('@expo/vector-icons/Ionicons', () => ({
  __esModule: true,
  default: 'Ionicons',
}));

// Mirrors the "Dose now" section in app/(tabs)/index.tsx: a row section
// whose card wrapper takes the remaining width via flex: 1, with the
// fixed-size + button as its sibling.
const sectionStyles = StyleSheet.create({
  nextDoseSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    marginBottom: 16,
  },
  nextDoseSectionCard: {
    flex: 1,
  },
  doseNowButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

function schedule(partial: Partial<DoseSchedule> = {}): DoseSchedule {
  return {
    id: 'sched-1',
    pumpId: 'alk',
    volumeMl: 1.5,
    timesPerDay: 1,
    startTime: '14:30',
    repeatEveryNDays: 1,
    enabled: true,
    lastRunAt: null,
    ...partial,
  };
}

/** Scheduled dose firing ~1h after the render, so the countdown shows "In …". */
function upcomingDose(): NextDose {
  return {
    kind: 'scheduled',
    schedule: schedule(),
    date: new Date(Date.now() + 60 * 60 * 1000),
  };
}

function renderSection(nextDose: NextDose | null) {
  return render(
    <View style={sectionStyles.nextDoseSection}>
      <View style={sectionStyles.nextDoseSectionCard}>
        <NextDoseCard nextDose={nextDose} onPress={() => {}} />
      </View>
      <Pressable
        style={sectionStyles.doseNowButton}
        accessibilityRole="button"
        accessibilityLabel="Dose now"
      />
    </View>,
  );
}

function flatten(style: StyleProp<ViewStyle>): ViewStyle {
  return StyleSheet.flatten(style ?? {}) as ViewStyle;
}

/** Nearest ancestor matching a predicate, or null. */
function findAncestor(
  instance: ReactTestInstance,
  predicate: (node: ReactTestInstance) => boolean,
): ReactTestInstance | null {
  let node = instance.parent;
  while (node) {
    if (predicate(node)) return node;
    node = node.parent;
  }
  return null;
}

/** Nearest HOST (native) ancestor matching a predicate. The test renderer
 * interop inserts composite wrapper fibers between host nodes, so
 * structural checks must skip non-host instances. */
function findHostAncestor(
  instance: ReactTestInstance,
  predicate: (node: ReactTestInstance) => boolean,
): ReactTestInstance | null {
  return findAncestor(
    instance,
    (node) => typeof node.type === 'string' && predicate(node),
  );
}

function isCardPressable(node: ReactTestInstance): boolean {
  return node.props?.accessibilityLabel === 'Next dose details';
}

/** The card's outer host view (glass base: bordered row with
 * justifyContent: 'space-between'). */
function cardRootOf(instance: ReactTestInstance): ReactTestInstance | null {
  return findHostAncestor(instance, (node) => {
    const style = flatten(node.props?.style);
    return style.borderWidth === 1 && style.flexDirection === 'row';
  });
}

/** The section row: the host row both the card wrapper and the + button
 * hang from. */
function sectionRow(instance: ReactTestInstance): ReactTestInstance | null {
  return findHostAncestor(
    instance,
    (node) => flatten(node.props?.style).flexDirection === 'row',
  );
}

/** The harness `flex: 1` card wrapper (style is exactly `{flex: 1}`). */
function cardWrapperOf(instance: ReactTestInstance): ReactTestInstance | null {
  return findHostAncestor(instance, (node) => {
    const style = flatten(node.props?.style);
    return style.flex === 1 && style.flexDirection === undefined;
  });
}

/**
 * The test renderer cannot measure pixels, so "the countdown never slides
 * under the + button at 320px" is proven structurally — these invariants
 * guarantee non-overlap at ANY width. A true pixel-overlap assertion needs
 * a real browser (e.g. the wide/web layout check in a Playwright run);
 * here we assert the flex contract that makes overlap impossible:
 * the button is a fixed-size sibling outside the card, the card wrapper
 * owns the remaining width, the countdown's block can never compress, and
 * the left block truncates before the countdown is ever touched.
 */
function expectShrinkProofStructure(nextDose: NextDose | null) {
  // 1. The + button is a fixed-size SIBLING of the card wrapper — never a
  //    descendant — so its touch target cannot intersect the card content
  //    by construction (no absolute positioning, no negative margins).
  const button = screen.getByRole('button', { name: 'Dose now' });
  const buttonStyle = flatten(button.props.style);
  expect(buttonStyle.width).toBe(52);
  expect(buttonStyle.height).toBe(52);
  for (const key of ['margin', 'marginLeft', 'marginRight', 'marginTop', 'marginBottom']) {
    const value = buttonStyle[key as keyof ViewStyle];
    expect(value === undefined || (value as number) >= 0).toBe(true);
  }
  const cardPressable = screen.getByRole('button', {
    name: 'Next dose details',
  });
  expect(findAncestor(button, isCardPressable)).toBeNull();

  // 2. Sibling, not descendant: both the button and the card wrapper hang
  //    from the same flexDirection: 'row' section — the wrapper takes the
  //    remaining width via flex: 1, the button its own fixed column.
  const wrapper = cardWrapperOf(cardPressable);
  expect(wrapper).not.toBeNull();
  expect(flatten(wrapper!.props.style).flex).toBe(1);
  expect(sectionRow(button)).not.toBeNull();
  expect(sectionRow(wrapper!)).toBe(sectionRow(button));

  // 3. The countdown lives inside the card, and its right-block ancestor
  //    is flexShrink: 0 with a single-line countdown — that block can never
  //    be compressed or pushed outside the card.
  const countdown = screen.getByText(/^In \d{2}:\d{2}:\d{2}$/);
  expect(findAncestor(countdown, isCardPressable)).not.toBeNull();
  const rightBlock = findHostAncestor(
    countdown,
    (node) =>
      flatten(node.props?.style).flexShrink === 0 &&
      flatten(node.props?.style).alignItems === 'flex-end',
  );
  expect(rightBlock).not.toBeNull();
  expect(countdown.props.numberOfLines).toBe(1);

  if (!nextDose) return;

  // 4. Pump name and volume truncate (middle-ellipsis, single line) with
  //    shrink enabled — the left block absorbs compression before the
  //    countdown is ever touched.
  const pumpName = screen.getByText('Alkalinity');
  expect(pumpName.props.numberOfLines).toBe(1);
  expect(pumpName.props.ellipsizeMode).toBe('middle');
  expect(flatten(pumpName.props.style).flexShrink).toBe(1);

  const volume = screen.getByText('1.5 mL');
  expect(volume.props.numberOfLines).toBe(1);
  expect(volume.props.ellipsizeMode).toBe('middle');
  expect(flatten(volume.props.style).flexShrink).toBe(1);

  // The left block itself is the flex: 1 shock absorber of the card row.
  const leftBlock = findHostAncestor(
    pumpName,
    (node) =>
      flatten(node.props?.style).flex === 1 &&
      flatten(node.props?.style).flexDirection === 'row',
  );
  expect(leftBlock).not.toBeNull();
  // The inner overline + name/tag/volume column is also flex: 1 so the row
  // truncates instead of overflowing.
  const bodyColumn = findHostAncestor(
    pumpName,
    (node) =>
      flatten(node.props?.style).flex === 1 &&
      flatten(node.props?.style).flexDirection === undefined,
  );
  expect(bodyColumn).not.toBeNull();
  // And the left block sits inside the card, ahead of the right block.
  expect(findAncestor(leftBlock!, isCardPressable)).not.toBeNull();
}

beforeEach(() => {
  resetAllMocks();
  setDimensions({ width: 375, height: 800, scale: 1, fontScale: 1 });
});

describe('NextDoseCard — populated (320px)', () => {
  it('uses the shrink-proof structure at the narrowest viewport', () => {
    setDimensions({ width: 320, height: 640, scale: 1, fontScale: 1 });
    expect(Dimensions.get('window').width).toBe(320);

    renderSection(upcomingDose());
    expectShrinkProofStructure(upcomingDose());
  });
});

describe('NextDoseCard — populated (375px)', () => {
  it('uses the shrink-proof structure at the default phone width', () => {
    renderSection(upcomingDose());
    expectShrinkProofStructure(upcomingDose());
  });
});

describe('NextDoseCard — populated (768px wide layout)', () => {
  it('uses the identical shrink-proof structure on wide layouts', () => {
    setDimensions({ width: 768, height: 1024, scale: 1, fontScale: 1 });
    expect(Dimensions.get('window').width).toBe(768);

    renderSection(upcomingDose());
    // Same invariants, no assertion changes: the wide layout relies on the
    // exact same flex contract, not on extra width.
    expectShrinkProofStructure(upcomingDose());
  });
});

describe('NextDoseCard — null state', () => {
  it.each([320, 375, 768])(
    'keeps the resting state shrink-proof at %ipx',
    (width) => {
      setDimensions({ width, height: 800, scale: 1, fontScale: 1 });
      renderSection(null);

      expect(screen.getByText('No doses scheduled')).toBeTruthy();
      // Resting state is informational only: no pressable card details.
      expect(
        screen.queryByRole('button', { name: 'Next dose details' }),
      ).toBeNull();

      const name = screen.getByText('No doses scheduled');
      expect(name.props.numberOfLines).toBe(1);
      expect(name.props.ellipsizeMode).toBe('middle');

      const button = screen.getByRole('button', { name: 'Dose now' });
      expect(flatten(button.props.style).width).toBe(52);
      // The + button is still a sibling of the card wrapper (row section).
      const cardRoot = cardRootOf(name);
      expect(cardRoot).not.toBeNull();
      const wrapper = cardWrapperOf(cardRoot!);
      expect(wrapper).not.toBeNull();
      expect(flatten(wrapper!.props.style).flex).toBe(1);
      expect(sectionRow(wrapper!)).toBe(sectionRow(button));
    },
  );
});
