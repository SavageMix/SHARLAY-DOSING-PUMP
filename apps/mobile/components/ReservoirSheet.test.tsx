import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Dimensions,
  ScrollView,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { resetAllMocks, setDimensions } from 'vitest-native/helpers';
import type { ContainerStatus } from '@reef/shared';

import { Theme } from '@/constants/Theme';
import { ReservoirSheet } from './ReservoirSheet';

// Decorative icon font — no native font loading in the test runtime.
vi.mock('@expo/vector-icons/Ionicons', () => ({
  __esModule: true,
  default: 'Ionicons',
}));

// Short-phone viewport with a real home-indicator inset: the "Edit details
// button is half-clipped" bug reproduced at test scale.
const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 600 },
  insets: { top: 0, right: 0, bottom: 34, left: 0 },
};

const container: ContainerStatus = {
  pumpId: 'alk',
  name: 'Alkalinity',
  capacityMl: 1000,
  currentMl: 500,
  lowThresholdMl: 100,
  updatedAt: '2026-08-23T18:00:00.000Z',
  daysRemaining: 10,
  low: false,
};

function makeProps(overrides: Partial<Parameters<typeof ReservoirSheet>[0]> = {}) {
  return {
    container,
    busy: false,
    error: null,
    onClose: vi.fn(),
    onRefillFull: vi.fn(),
    onRefillPartial: vi.fn(),
    onAdjust: vi.fn(),
    onUpdate: vi.fn(),
    ...overrides,
  };
}

function renderSheet(props: Parameters<typeof ReservoirSheet>[0] = makeProps()) {
  // SafeAreaProvider is required by useSafeAreaInsets; the metrics also let
  // the test assert the safe-area-aware bottom clearance.
  return render(
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <ReservoirSheet {...props} />
    </SafeAreaProvider>,
  );
}

function flatten(style: StyleProp<ViewStyle>): ViewStyle {
  return StyleSheet.flatten(style ?? {}) as ViewStyle;
}

function isTextInput(instance: ReactTestInstance): boolean {
  return (
    (typeof instance.type === 'string' &&
      instance.type.toLowerCase().includes('textinput')) ||
    typeof instance.props?.placeholder === 'string'
  );
}

function containsTextInput(instance: ReactTestInstance): boolean {
  if (isTextInput(instance)) return true;
  return instance.children.some(
    (child) => typeof child !== 'string' && containsTextInput(child),
  );
}

/** The exact structural cause of the old 1280px clip: a submit button
 * sharing a `flexDirection: 'row'` ancestor with a text input. */
function sharesRowWithTextInput(instance: ReactTestInstance): boolean {
  let node = instance.parent;
  while (node) {
    if (
      flatten(node.props?.style).flexDirection === 'row' &&
      containsTextInput(node)
    ) {
      return true;
    }
    node = node.parent;
  }
  return false;
}

/**
 * jsdom/test-renderer cannot do pixel layout, so "fully visible at 1280px" is
 * proven structurally: the button is queryable by accessible name, has no
 * fixed pixel width on its flattened style, and never shares a row with a
 * text input (the old `sheetInputRow` layout that clipped it).
 */
function expectUnclippedFullWidthButton(name: string): ReactTestInstance {
  const button = screen.getByRole('button', { name });
  expect(flatten(button.props.style).width).toBeUndefined();
  expect(sharesRowWithTextInput(button)).toBe(false);
  return button;
}

beforeEach(() => {
  resetAllMocks();
  // Wide/web viewport the buttons used to be clipped on.
  setDimensions({ width: 1280, height: 800, scale: 1, fontScale: 1 });
  expect(Dimensions.get('window').width).toBe(1280);
});

describe('ReservoirSheet — default mode', () => {
  it('contains the Edit details icon and label within the button bounds', () => {
    renderSheet();

    const button = screen.getByRole('button', { name: 'Edit details' });
    const style = flatten(button.props.style);
    // The old bug: modalButton has no flexDirection, so the icon and label
    // stacked vertically in the fixed-height button and overflowed it. The
    // test renderer cannot measure pixels, so containment is proven
    // structurally: a single centred row inside the fixed-height button
    // places icon and label side-by-side on one line, fully within its
    // bounds (same layout contract as the confirmButton siblings).
    expect(style.flexDirection).toBe('row');
    expect(style.alignItems).toBe('center');
    expect(style.justifyContent).toBe('center');
    expect(style.height).toBeGreaterThan(0);
    // Both contents render as children of the button itself.
    expect(button.findAll((node) => String(node.type) === 'Ionicons').length).toBe(1);
    expect(
      button.findAll(
        (node) =>
          typeof node.children[0] === 'string' &&
          node.children[0].includes('Edit details'),
      ).length,
    ).toBe(1);
  });

  it('renders the partial refill and adjust sections at a 1280px viewport', () => {
    renderSheet();

    expect(Dimensions.get('window').width).toBe(1280);
    expect(screen.getByText('PARTIAL REFILL')).toBeTruthy();
    expect(screen.getByText('ADJUST LEVEL')).toBeTruthy();
    expect(screen.getByPlaceholderText('Volume (mL)')).toBeTruthy();
    expect(screen.getByPlaceholderText('Current level (mL)')).toBeTruthy();
    expect(
      screen.getByText('Adds to current level, up to capacity'),
    ).toBeTruthy();
    expect(
      screen.getByText('Overrides the current level exactly'),
    ).toBeTruthy();
  });

  it('keeps every submit button unclipped at 1280px (structural proof)', () => {
    renderSheet();

    expectUnclippedFullWidthButton('Refill to full');
    expectUnclippedFullWidthButton('Refill partial');
    expectUnclippedFullWidthButton('Set level');
  });

  it('partial refill ADDS the entered volume to the current level', () => {
    const props = makeProps();
    renderSheet(props);

    fireEvent.changeText(screen.getByPlaceholderText('Volume (mL)'), '250');
    fireEvent.press(screen.getByRole('button', { name: 'Refill partial' }));

    expect(props.onRefillPartial).toHaveBeenCalledTimes(1);
    expect(props.onRefillPartial).toHaveBeenCalledWith(750);
  });

  it('partial refill clamps the total at capacity', () => {
    const props = makeProps();
    renderSheet(props);

    fireEvent.changeText(screen.getByPlaceholderText('Volume (mL)'), '600');
    fireEvent.press(screen.getByRole('button', { name: 'Refill partial' }));

    expect(props.onRefillPartial).toHaveBeenCalledWith(1000);
  });

  it('rejects a non-positive partial refill volume', () => {
    const props = makeProps();
    renderSheet(props);

    fireEvent.changeText(screen.getByPlaceholderText('Volume (mL)'), '-5');
    fireEvent.press(screen.getByRole('button', { name: 'Refill partial' }));

    expect(props.onRefillPartial).not.toHaveBeenCalled();
    expect(screen.getByText('Enter a positive volume')).toBeTruthy();
  });

  it('adjust overrides the level exactly and allows zero', () => {
    const props = makeProps();
    renderSheet(props);

    fireEvent.changeText(
      screen.getByPlaceholderText('Current level (mL)'),
      '0',
    );
    fireEvent.press(screen.getByRole('button', { name: 'Set level' }));
    expect(props.onAdjust).toHaveBeenCalledWith(0);

    fireEvent.changeText(
      screen.getByPlaceholderText('Current level (mL)'),
      '300',
    );
    fireEvent.press(screen.getByRole('button', { name: 'Set level' }));
    expect(props.onAdjust).toHaveBeenCalledWith(300);
  });

  it('rejects a negative adjust level', () => {
    const props = makeProps();
    renderSheet(props);

    fireEvent.changeText(
      screen.getByPlaceholderText('Current level (mL)'),
      '-1',
    );
    fireEvent.press(screen.getByRole('button', { name: 'Set level' }));

    expect(props.onAdjust).not.toHaveBeenCalled();
    expect(screen.getByText('Enter 0 or a positive level')).toBeTruthy();
  });

  it('starts the refill-to-full confirmation flow', () => {
    const props = makeProps();
    renderSheet(props);

    fireEvent.press(screen.getByRole('button', { name: 'Refill to full' }));
    expect(
      screen.getByText('Refill Alkalinity to full (1000 mL)?'),
    ).toBeTruthy();

    fireEvent.press(screen.getByRole('button', { name: 'Refill' }));
    expect(props.onRefillFull).toHaveBeenCalledTimes(1);
  });
});

describe('ReservoirSheet — editing mode', () => {
  function renderEditing() {
    const view = renderSheet();
    fireEvent.press(screen.getByRole('button', { name: 'Edit details' }));
    return view;
  }

  it('shows labelled fields, the threshold helper, and an unclipped Save', () => {
    renderEditing();

    for (const label of [
      'Reservoir name',
      'Capacity (mL)',
      'Low alert threshold (mL)',
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    expect(
      screen.getByText('Banner alerts when level drops to this'),
    ).toBeTruthy();

    expectUnclippedFullWidthButton('Save');
    // The primary actions stay reachable in editing mode too.
    expectUnclippedFullWidthButton('Refill to full');
  });

  it('hides the edit fields until Edit details is pressed', () => {
    renderSheet();
    expect(screen.queryByLabelText('Reservoir name')).toBeNull();
    expect(
      screen.queryByText('Banner alerts when level drops to this'),
    ).toBeNull();
  });

  it('saves the edited reservoir', () => {
    const props = makeProps();
    renderSheet(props);
    fireEvent.press(screen.getByRole('button', { name: 'Edit details' }));

    fireEvent.changeText(screen.getByLabelText('Reservoir name'), 'Ca');
    fireEvent.changeText(screen.getByLabelText('Capacity (mL)'), '2000');
    fireEvent.changeText(
      screen.getByLabelText('Low alert threshold (mL)'),
      '150',
    );
    fireEvent.press(screen.getByRole('button', { name: 'Save' }));

    expect(props.onUpdate).toHaveBeenCalledWith({
      name: 'Ca',
      capacityMl: 2000,
      lowThresholdMl: 150,
    });
  });

  it('matches the fully-expanded snapshot (labels + helper + Save)', () => {
    const view = renderEditing();
    expect(view.toJSON()).toMatchSnapshot();
  });
});


/**
 * The original bug: at a short viewport the sheet's content exceeded its max
 * height and the bottom "Edit details" button rendered half-clipped. The
 * test-renderer cannot measure pixels, so "reachable via scroll and not
 * clipped" is proven structurally at 600px: the content area is a BOUNDED
 * ScrollView (flex:1 inside the maxHeight'd sheet) — an unbounded ScrollView
 * sizes to its content and overflows the sheet instead of scrolling, which
 * is exactly what clipped the button — with safe-area-aware end padding, and
 * every action button present in the tree in both modes.
 */
describe('ReservoirSheet — short viewport (600px)', () => {
  function scrollView(): ReactTestInstance {
    return screen.UNSAFE_getByType(ScrollView);
  }

  function ancestorTypes(instance: ReactTestInstance): unknown[] {
    const types: unknown[] = [];
    let node = instance.parent;
    while (node) {
      types.push(node.type);
      node = node.parent;
    }
    return types;
  }

  beforeEach(() => {
    // Short viewport the clip reproduced on.
    setDimensions({ width: 390, height: 600, scale: 1, fontScale: 1 });
    expect(Dimensions.get('window').height).toBe(600);
  });

  it('bounds the content in a flexing ScrollView inside the maxHeight sheet', () => {
    renderSheet();

    const scroll = scrollView();
    expect(flatten(scroll.props.style).flex).toBe(1);

    // Scroll-end clearance: device safe-area inset + token spacing, so the
    // last element clears the sheet edge and the home-indicator strip.
    expect(scroll.props.contentContainerStyle.paddingBottom).toBe(
      SAFE_AREA_METRICS.insets.bottom + Theme.spacing.xxl,
    );

    // The sheet itself is height-capped — that cap is what engages scrolling
    // instead of overflow once content exceeds the viewport.
    const sheet = scroll.parent!;
    expect(flatten(sheet.props.style).maxHeight).toBe('88%');
  });

  it('keeps the close control fixed outside the scrolling area', () => {
    renderSheet();

    const close = screen.getByRole('button', { name: 'Close' });
    expect(ancestorTypes(close)).not.toContain(ScrollView);
    expect(screen.getByText('Alkalinity')).toBeTruthy();
  });

  it('renders every action button in the tree at 600px — reachable via scroll', () => {
    renderSheet();

    for (const name of [
      'Close',
      'Refill to full',
      'Refill partial',
      'Set level',
      'Edit details',
    ]) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }

    // Expand the edit form: its controls must be just as reachable.
    fireEvent.press(screen.getByRole('button', { name: 'Edit details' }));
    for (const name of ['Save', 'Cancel']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    for (const label of [
      'Reservoir name',
      'Capacity (mL)',
      'Low alert threshold (mL)',
    ]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
  });
});
