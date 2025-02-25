import * as React from 'react';
import { StyleSheet, BackHandler } from 'react-native';
import Animated from 'react-native-reanimated';
import {
  PanGestureHandler,
  State as GestureState,
} from 'react-native-gesture-handler';
import { Screen } from 'react-native-screens';
import { InterpolatorProps, InterpolatedStyle } from '../CardStyleInterpolator';

type SpringConfig = {
  damping: number;
  mass: number;
  stiffness: number;
  restSpeedThreshold: number;
  restDisplacementThreshold: number;
  overshootClamping: boolean;
};

type TimingConfig = {
  duration: number;
  easing: Animated.EasingFunction;
};

type TransitionSpec =
  | { timing: 'spring'; config: SpringConfig }
  | { timing: 'timing'; config: TimingConfig };

type Props = {
  index: number;
  focused: boolean;
  stale: boolean;
  next?: Animated.Node<number>;
  current: Animated.Value<number>;
  layout: { width: number; height: number };
  direction: 'horizontal' | 'vertical';
  onOpen?: () => void;
  onClose?: () => void;
  children: (props: { close: () => void }) => React.ReactNode;
  gesturesEnabled: boolean;
  transitionSpec: TransitionSpec;
  styleInterpolator: (props: InterpolatorProps) => InterpolatedStyle;
};

type Binary = 0 | 1;

const TRUE = 1;
const FALSE = 0;
const NOOP = 0;
const UNSET = -1;

const DIRECTION_VERTICAL = -1;
const DIRECTION_HORIZONTAL = 1;

const SWIPE_VELOCITY_THRESHOLD_DEFAULT = 500;
const SWIPE_DISTANCE_THRESHOLD_DEFAULT = 60;

const SWIPE_DISTANCE_MINIMUM = 5;

const {
  cond,
  eq,
  neq,
  set,
  and,
  or,
  greaterThan,
  lessThan,
  add,
  max,
  multiply,
  abs,
  block,
  stopClock,
  startClock,
  clockRunning,
  onChange,
  Value,
  Clock,
  call,
  spring,
  timing,
  interpolate,
} = Animated;

const SPRING_CONFIG = {
  stiffness: 1000,
  damping: 500,
  mass: 3,
  overshootClamping: true,
  restDisplacementThreshold: 0.01,
  restSpeedThreshold: 0.01,
};

export default class Card extends React.Component<Props> {
  static defaultProps = {
    direction: 'horizontal',
    transitionSpec: {
      timing: 'spring',
      config: SPRING_CONFIG,
    },
    gesturesEnabled: true,
  };

  componentDidMount() {
    BackHandler.addEventListener('hardwareBackPress', this.handleBackPress);
  }

  componentWillUnmount() {
    BackHandler.removeEventListener('hardwareBackPress', this.handleBackPress);
  }

  componentDidUpdate(prevProps: Props) {
    const { layout, direction, transitionSpec } = this.props;
    const { width, height } = layout;

    if (width !== prevProps.layout.width) {
      this.layout.width.setValue(width);
    }

    if (height !== prevProps.layout.height) {
      this.layout.height.setValue(height);
    }

    if (direction !== prevProps.direction) {
      this.direction.setValue(
        direction === 'vertical' ? DIRECTION_VERTICAL : DIRECTION_HORIZONTAL
      );
    }

    if (transitionSpec !== prevProps.transitionSpec) {
      this.runTransition = this.createTransition(transitionSpec);
    }
  }

  private isOpen: boolean | undefined;
  private isVisibleValue = TRUE;

  private isVisible = new Value<Binary>(TRUE);
  private nextIsVisible = new Value<Binary | -1>(UNSET);

  private clock = new Clock();

  private direction = new Value(
    this.props.direction === 'vertical'
      ? DIRECTION_VERTICAL
      : DIRECTION_HORIZONTAL
  );

  private layout = {
    width: new Value(this.props.layout.width),
    height: new Value(this.props.layout.height),
  };

  private distance = cond(
    eq(this.direction, DIRECTION_VERTICAL),
    this.layout.height,
    this.layout.width
  );

  private position = new Value(
    this.props.direction === 'vertical'
      ? this.props.layout.height
      : this.props.layout.width
  );

  private gesture = new Value(0);
  private offset = new Value(0);
  private velocity = new Value(0);

  private gestureState = new Value(0);

  private isSwiping = new Value(FALSE);
  private isSwipeGesture = new Value(FALSE);

  private toValue = new Value(0);
  private frameTime = new Value(0);

  private transitionState = {
    position: this.position,
    time: new Value(0),
    finished: new Value(FALSE),
  };

  private createTransition = (transitionSpec: TransitionSpec) => (
    isVisible: Binary | Animated.Node<number>
  ) => {
    return block([
      cond(clockRunning(this.clock), NOOP, [
        // Animation wasn't running before
        // Set the initial values and start the clock
        set(this.toValue, cond(isVisible, 0, this.distance)),
        set(this.frameTime, 0),
        set(this.transitionState.time, 0),
        set(this.transitionState.finished, FALSE),
        set(this.isVisible, isVisible),
        startClock(this.clock),
      ]),
      transitionSpec.timing === 'spring'
        ? spring(
            this.clock,
            { ...this.transitionState, velocity: this.velocity },
            { ...transitionSpec.config, toValue: this.toValue }
          )
        : timing(
            this.clock,
            { ...this.transitionState, frameTime: this.frameTime },
            { ...transitionSpec.config, toValue: this.toValue }
          ),
      cond(this.transitionState.finished, [
        // Reset values
        set(this.isSwipeGesture, FALSE),
        set(this.gesture, 0),
        set(this.velocity, 0),
        // When the animation finishes, stop the clock
        stopClock(this.clock),
        call([this.isVisible], ([value]: ReadonlyArray<Binary>) => {
          const isOpen = Boolean(value);
          const { onOpen, onClose } = this.props;

          if (isOpen !== this.isOpen) {
            if (isOpen) {
              onOpen && onOpen();
            } else {
              onClose && onClose();
            }
          }

          this.isOpen = isOpen;
        }),
      ]),
    ]);
  };

  private runTransition = this.createTransition(this.props.transitionSpec);

  private translate = block([
    onChange(
      this.isVisible,
      call([this.isVisible], ([value]) => {
        this.isVisibleValue = value;
      })
    ),
    onChange(
      this.nextIsVisible,
      cond(neq(this.nextIsVisible, UNSET), [
        // Stop any running animations
        cond(clockRunning(this.clock), stopClock(this.clock)),
        // Update the index to trigger the transition
        set(this.isVisible, this.nextIsVisible),
        set(this.nextIsVisible, UNSET),
      ])
    ),
    // Synchronize the translation with the animated value representing the progress
    set(
      this.props.current,
      cond(
        or(eq(this.layout.width, 0), eq(this.layout.height, 0)),
        this.isVisible,
        interpolate(this.position, {
          inputRange: [0, this.distance],
          outputRange: [1, 0],
        })
      )
    ),
    cond(
      eq(this.gestureState, GestureState.ACTIVE),
      [
        cond(this.isSwiping, NOOP, [
          // We weren't dragging before, set it to true
          set(this.isSwiping, TRUE),
          set(this.isSwipeGesture, TRUE),
          // Also update the drag offset to the last position
          set(this.offset, this.position),
        ]),
        // Update position with next offset + gesture distance
        set(this.position, max(add(this.offset, this.gesture), 0)),
        // Stop animations while we're dragging
        stopClock(this.clock),
      ],
      [
        set(this.isSwiping, FALSE),
        this.runTransition(
          cond(
            or(
              and(
                greaterThan(abs(this.gesture), SWIPE_DISTANCE_MINIMUM),
                greaterThan(
                  abs(this.velocity),
                  SWIPE_VELOCITY_THRESHOLD_DEFAULT
                )
              ),
              cond(
                greaterThan(
                  abs(this.gesture),
                  SWIPE_DISTANCE_THRESHOLD_DEFAULT
                ),
                TRUE,
                FALSE
              )
            ),
            cond(
              lessThan(
                cond(eq(this.velocity, 0), this.gesture, this.velocity),
                0
              ),
              TRUE,
              FALSE
            ),
            this.isVisible
          )
        ),
      ]
    ),
    this.position,
  ]);

  private handleGestureEventHorizontal = Animated.event([
    {
      nativeEvent: {
        translationX: this.gesture,
        velocityX: this.velocity,
        state: this.gestureState,
      },
    },
  ]);

  private handleGestureEventVertical = Animated.event([
    {
      nativeEvent: {
        translationY: this.gesture,
        velocityY: this.velocity,
        state: this.gestureState,
      },
    },
  ]);

  private isFirst = () => this.props.index === 0;

  private handleBackPress = () => {
    if (this.isVisibleValue && !this.isFirst()) {
      this.nextIsVisible.setValue(FALSE);

      return true;
    } else {
      return false;
    }
  };

  private handleClose = () => {
    this.isFirst() || this.nextIsVisible.setValue(FALSE);
  };

  render() {
    const {
      focused,
      stale,
      layout,
      current,
      next,
      direction,
      gesturesEnabled,
      children,
      styleInterpolator,
    } = this.props;

    const { cardStyle, overlayStyle } = styleInterpolator({
      current,
      next,
      layout,
    });

    const handleGestureEvent =
      direction === 'vertical'
        ? this.handleGestureEventVertical
        : this.handleGestureEventHorizontal;

    return (
      <Screen
        // We need to wrap the screen in a non-collapsable view, otherwise the overlay doesn't show on Android
        // The elevation shadow is also not-visible without this
        collapsable={false}
        // @ts-ignore
        active={stale ? 0 : 1}
        style={[StyleSheet.absoluteFill]}
        pointerEvents="box-none"
      >
        <Animated.View
          // This doesn't actually do anything, but we need to pass the animated value to native
          // Otherwise the reanimated logic won't work, this is just a hack to make sure it's passed
          // Usually we'd pass it to the Animated.View inside the PanGestureHandler, but we can't be sure with interpolated styles
          style={{ height: multiply(this.translate, 0) }}
        />
        {overlayStyle ? (
          <Animated.View
            pointerEvents="none"
            style={[styles.overlay, overlayStyle]}
          />
        ) : null}
        <PanGestureHandler
          enabled={layout.width !== 0 && !this.isFirst() && gesturesEnabled}
          onGestureEvent={handleGestureEvent}
          onHandlerStateChange={handleGestureEvent}
        >
          <Animated.View
            accessibilityElementsHidden={!focused}
            importantForAccessibility={focused ? 'auto' : 'no-hide-descendants'}
            style={[styles.card, cardStyle]}
          >
            {children({
              close: this.handleClose,
            })}
          </Animated.View>
        </PanGestureHandler>
      </Screen>
    );
  }
}

const styles = StyleSheet.create({
  card: {
    ...StyleSheet.absoluteFillObject,
    shadowOffset: { width: -1, height: 1 },
    shadowRadius: 5,
    shadowColor: '#000',
    backgroundColor: 'white',
    elevation: 4,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
});
