import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Dimensions,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { resetAllMocks, setDimensions } from 'vitest-native/helpers';
import type { ContainerStatus } from '@reef/shared';

import { ReservoirSheet } from './ReservoirSheet';

// Decorative icon font — no native font loading in the test runtime.
vi.mock('@expo/vector-icons/Ionicons', () => ({
  __esModule: true,
  default: 'Ionicons',
}));

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
  it('renders the partial refill and adjust sections at a 1280px viewport', () => {
    render(<ReservoirSheet {...makeProps()} />);

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
    render(<ReservoirSheet {...makeProps()} />);

    expectUnclippedFullWidthButton('Refill to full');
    expectUnclippedFullWidthButton('Refill partial');
    expectUnclippedFullWidthButton('Set level');
  });

  it('partial refill ADDS the entered volume to the current level', () => {
    const props = makeProps();
    render(<ReservoirSheet {...props} />);

    fireEvent.changeText(screen.getByPlaceholderText('Volume (mL)'), '250');
    fireEvent.press(screen.getByRole('button', { name: 'Refill partial' }));

    expect(props.onRefillPartial).toHaveBeenCalledTimes(1);
    expect(props.onRefillPartial).toHaveBeenCalledWith(750);
  });

  it('partial refill clamps the total at capacity', () => {
    const props = makeProps();
    render(<ReservoirSheet {...props} />);

    fireEvent.changeText(screen.getByPlaceholderText('Volume (mL)'), '600');
    fireEvent.press(screen.getByRole('button', { name: 'Refill partial' }));

    expect(props.onRefillPartial).toHaveBeenCalledWith(1000);
  });

  it('rejects a non-positive partial refill volume', () => {
    const props = makeProps();
    render(<ReservoirSheet {...props} />);

    fireEvent.changeText(screen.getByPlaceholderText('Volume (mL)'), '-5');
    fireEvent.press(screen.getByRole('button', { name: 'Refill partial' }));

    expect(props.onRefillPartial).not.toHaveBeenCalled();
    expect(screen.getByText('Enter a positive volume')).toBeTruthy();
  });

  it('adjust overrides the level exactly and allows zero', () => {
    const props = makeProps();
    render(<ReservoirSheet {...props} />);

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
    render(<ReservoirSheet {...props} />);

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
    render(<ReservoirSheet {...props} />);

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
    const view = render(<ReservoirSheet {...makeProps()} />);
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
    render(<ReservoirSheet {...makeProps()} />);
    expect(screen.queryByLabelText('Reservoir name')).toBeNull();
    expect(
      screen.queryByText('Banner alerts when level drops to this'),
    ).toBeNull();
  });

  it('saves the edited reservoir', () => {
    const props = makeProps();
    render(<ReservoirSheet {...props} />);
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
