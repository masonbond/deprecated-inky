;var IN = (function() {"use strict";

// TODO FIRST remove gravity from accelerationIncludingGravity yourself, inbuilt blows chunks
// TODO 		maybe use orientation to determine which way is "down" and deduct normalized 1G vector in that direction from that
// TODO 		maybe also use per-component deadzone? each component susceptible to mad noise
// TODO 		little noise on 1s delay average, slightly less on 2 .5s ones; cyclic noise?
// TODO NEXT accurize position
// TODO THIRDST test input filters
// TODO component "groups" such as X, Y, Z for vectored types and V for buttons?
// TODO 		maybe create premade move arguments that filter based on name?
// TODO MOTION_ORIENTATION_MAGNITUDE
// TODO deadZone wrapping for ORIENTATION_Z?
// TODO 'normalize' acceleration, acceleration w/ gravity and rotation rate by subtracting components of deadZone-magnitude scaled version of itself
// TODO MOTION_POSITION that takes orientation into account; this is what gets calibrated by calibratePosition
// TODO radius fallback when pressure is undefined on touch events?
//		gotta test this one as my phone's native radius->pressure simulation is weak as hell
// TODO chaining for all objects
// TODO inconsistency with deadzone treatment and manual normalization? wtf does this mean come on man
// TODO re-test mouse move dx/dy compatibility after browserFamily removal
// TODO mouse move custom args
// TODO multitouch audit/necessary fixes
// TODO onError callback for pointer lock requests
// TODO way to select radial when rebinding, maybe group like components and give resolveConflict callback to bind?

// helpful constants
var constants = {
	DOUBLE_PI: Math.PI * 2,
	HALF_PI: Math.PI / 2,
	DEGREES_TO_RADIANS: Math.PI / 180
};

// static privates

// helpers

function indexOfListener(obj, component, control) {
	for (var i = 0, l = obj[component].length; i < l; ++i) {
		if (obj[component][i].control === control) return i;
	}

	return -1;
}

function addListener(obj, component, listener, prepend) {
	obj[component] = obj[component] || [];
	if (indexOfListener(obj, component, listener.control) !== -1) return;
	obj[component][prepend ? 'unshift' : 'push'](listener);
}

function removeListener(obj, component, listener, prepend) {
	if (!obj[component]) return;
	var i = indexOfListener(obj, component, listener.control);

	if (i !== -1) {
		obj[component].splice(i, 1);
		if (obj[component].length === 0) delete obj[component];
	}
}

function modifyListeners(callback, listeners, component, listener, prepend) {
	if (component === undefined) {
		// modify listeners for every component matching the control
		for (var comp in components) {
			callback(listeners, components[comp], listener, prepend);
		}
	} else if (UTILS.isArray(component)) {
		// modify listeners for every component in array
		for (var i = 0, l = component.length; i < l; ++i) {
			callback(listeners, component[i], listener, prepend);
		}
	} else {
		// modify listeners for single component and control
		callback(listeners, component, listener, prepend);
	}
}

function beforePress(event, component) {
	var b = event.binding;
	if (b.timePressed[component] !== undefined || !b.control.enabled) return;

	b.timePressed[component] = event.time;

	event.type = pi.PRESS;
	event.time = b.timePressed[component];

	return b.control.press && b.control.press.call(b, event);
}

function beforeHold(event, component, duration) {
	var b = event.binding;
	if (b.timePressed[component] === undefined) return;

	event.type = pi.HOLD;
	event.duration = duration === undefined ? event.time - b.timePressed[component] : duration;
	
	return b.control.hold
		&& b.control.enabled 
		&& b.control.hold.call(b, event);
}

function beforeRelease(event, component, duration) {
	var b = event.binding;
	if (b.timePressed[component] === undefined || !b.control.enabled) return;
	var dt = duration === undefined ? event.time - b.timePressed[component] : duration;
	delete b.timePressed[component];

	event.type = pi.RELEASE;
	event.duration = dt;

	return b.control.release && b.control.release.call(b, event);
}

function beforeMove(event, component, args) {
	var b = event.binding;
	if (b.moveArgs && component !== pi.MOUSE_MOVE) {
		for (var arg in b.moveArgs) {
			var transform = b.moveArgs[arg];

			if (typeof transform === 'function') {
				// transform is a custom function
				var old = args[arg] || 0;
				args["d" + arg] = (args[arg] = transform(args.v)) - old;
			} else if (typeof transform === 'number') {
				// transform is a scaling value
				args[arg] = args.v * transform;
				args["d" + arg] = args.dv * transform;
			}
		}
	}

	event.type = pi.MOVE;
	event.move = args;

	return b.control.enabled
		&& b.control.move
		// TODO can we ditch && (component === pi.MOUSE_MOVE || b.timePressed[component] !== undefined)
		&& b.control.move.call(b, event);
}

function raiseEvents(dispatcher, listeners, event, component, time, arg2) {
	if (!listeners) return;

	for (var i = 0, binding; binding = listeners[i]; ++i) {
		var e = {
			binding: binding,
			target: binding.target, // alias the target here in case a prior callback changes the binding object
			component: component,
			device: componentToDevice[component],
			time: time === undefined ? UTILS.Timer.now() : time
		}

		event(e, component, arg2)
	}
}

function normalize2DComponents(values, xName, yName, a, o, h, deadZone) {
	var sin = Math.abs(o / h),
		cos = Math.abs(a / h),
		xNorm = cos > 0 ? Math.min(1, values[xName] / cos) : 0,
		yNorm = sin > 0 ? Math.min(1, values[yName] / sin) : 0,
		range = 1 - deadZone;

	values[xName] = cos * (xNorm > 0 ? Math.max(0, (xNorm - deadZone) / range) : Math.min(0, (xNorm + deadZone) / range));
	values[yName] = sin * (yNorm > 0 ? Math.max(0, (yNorm - deadZone) / range) : Math.min(0, (yNorm + deadZone) / range));
}

// top-level callbacks and properties
var pointerLockElement;
var onEnterPointerLock;
var onExitPointerLockElement;
var onExitPointerLock;
var focusedElement;

function pointerLockChange(e) {
	var element = document[UTILS.getMember(document, ["pointerLockElement", "webkitPointerLockElement", "mozPointerLockElement"])];
	if (element) { // pointer locked
		if (element !== pointerLockElement) { // do nothing if the element is already locked
			var oldElement = pointerLockElement;
			pi.Mouse.pointerLockElement = pointerLockElement = element;

			// if the pointer was already locked to an element, fire that element's onExit callback first
			if (oldElement) {
				if (onExitPointerLockElement) onExitPointerLockElement(e);
				onExitPointerLockElement = undefined;
			}

			// fire the onEnter callback for the new pointerLockElement
			if (onEnterPointerLock) {
				onEnterPointerLock(e);
				onEnterPointerLock = undefined;
			}
		}
	} else { // pointer unlocked
		pi.Mouse.pointerLockElement = pointerLockElement = undefined;

		// fire the old element's onExit callback
		if (onExitPointerLockElement) {
			onExitPointerLockElement(e);
			onExitPointerLockElement = undefined;
		}

		// if we programatically exited pointer lock and supplied an additional onExit callback, fire it now
		if (onExitPointerLock) {
			onExitPointerLock(e);
			onExitPointerLock = undefined;
		}
	}
}

function pointerLockError(e) {
	console.log("POINTER ERROR", e);
}

function trackFocus(e) {
	focusedElement = e.toElement || (e.type === "blur" && (e.relatedTarget || document.body)) || e.target;
	// e.toElement is the html element when you exit the document body
	if (focusedElement === document.body.parentElement) focusedElement = document.body;
}

// attach global mouse listeners

document.addEventListener("mouseover", trackFocus, true);
document.addEventListener("mouseout", trackFocus, true);
document.addEventListener("focus", trackFocus, true);
document.addEventListener("blur", trackFocus, true);

document.addEventListener("pointerlockchange", pointerLockChange);
document.addEventListener("mozpointerlockchange", pointerLockChange);
document.addEventListener("webkitpointerlockchange", pointerLockChange);

document.addEventListener("pointerlockerror", pointerLockError);
document.addEventListener("mozpointerlockerror", pointerLockError);
document.addEventListener("webkitpointerlockerror", pointerLockError);

// device stuff

var touchAreaId = 0;
var userDeviceId = 0;

// dispatcher list for custom components

var dispatchers = [];

// create public interface
var pi = {
	version: "0.8",
	async: {},
	support: {
		devicemotion: 'devicemotion' in window,
		touch: 'touchstart' in window,
		gamepad: 'getGamepads' in navigator || 'webkitGetGamepads' in navigator
	},
	motionInterval: undefined,
	press: function(component, time) {
		for (var i = 0, dispatcher; dispatcher = dispatchers[i]; ++i) dispatcher.press(component, time);
	},
	hold: function(component, duration, time) {
		for (var i = 0, dispatcher; dispatcher = dispatchers[i]; ++i) dispatcher.hold(component, duration, time);
	},
	release: function(component, duration, time) {
		for (var i = 0, dispatcher; dispatcher = dispatchers[i]; ++i) dispatcher.release(component, duration, time);
	},
	move: function(component, args, time) {
		for (var i = 0, dispatcher; dispatcher = dispatchers[i]; ++i) dispatcher.move(component, args, time);
	},
	Mouse: {
		position: {x: undefined, y: undefined},
		exitPointerLock: function(onExit) {
			document.exitPointerLock = document[UTILS.getMember(document, ["exitPointerLock", "webkitExitPointerLock", "mozExitPointerLock"])];
			onExitPointerLock = onExit;
			document.exitPointerLock();
		},
		pointerLockElement: undefined
	},
	Dispatcher: function(args) { 
		var oldTargetElement = args && args.element || document.body;
		var DOMElement = oldTargetElement;
		var listeners = {};
		var oldPollRate = args && args.pollRate !== undefined ? args.pollRate : defaults.pollRate;
		var pollInterval = setInterval(autoPoll, oldPollRate);
		var pads = [];
		var derived = [0, 0, 0, 0];
		var oldDerived = [0, 0, 0, 0];
		var oldMX = undefined, oldMY = undefined;

		var rebindTarget = {
			control: undefined,
			oldDeadZone: undefined
		};

		var rebindControl = new pi.Control({
			target: rebindTarget,
			press: function(device, component) {
				result.unbind({control:rebindControl});
				result.bind({
					control: this.control,
					component: component
				});

				result.analogDeadZone = this.oldDeadZone;

				this.control = undefined;
				this.oldDeadZone = undefined;
			}
		});

		// private callbacks and polling funcs

		function isFocused() {
			return (result.allowFocusOnHover && focusedElement === oldTargetElement) || pointerLockElement === oldTargetElement;
		}

		function autoPoll() {
			// update and check poll interval even if autoPoll is false
			if (oldPollRate != result.pollRate) {
				oldPollRate = result.pollRate;
				clearInterval(pollInterval);
				pollInterval = setInterval(autoPoll, oldPollRate);
			}

			if (!result.autoPoll) return;
			result.poll();
		}

		// gamepad

		function pollGamepads() {
			if (!getGamepads) return;

			var newPads = navigator[getGamepads]();
			var refreshPads = false;

			for (var i = 0; i < maxPads; ++i) {
				if ((!!newPads[i] !== !!pads[i]) 
					|| (newPads[i] && pads[i] && pads[i].id !== newPads[i].id)) {
					refreshPads = true;
					break;
				}
			}

			if (refreshPads) {
				// gotta copy individual values instead of object refs
				for (var i = 0; i < maxPads; ++i) {
					var cur = newPads[i];
					if (cur) {
						var old = pads[i] = {
							id: cur.id,
							timestamp: cur.timestamp,
							axes: [],
							buttons: []
						};

						for (var j = 0; cur.axes[j] !== undefined && j < maxAxes; ++j) {
							old.axes[j] = cur.axes[j];
						}
						for (var j = 0; cur.buttons[j] !== undefined && j < maxButtons; ++j) {
							old.buttons[j] = cur.buttons[j].value;
						}
					} else {
						pads[i] = undefined;
					}
				}
				return;
			}

			for (var i = 0, li = newPads.length; i < li; ++i) {
				// compare old gamepad component values to new ones and raise appropriate events
				var cur = newPads[i];
				var old = pads[i];

				if (!cur || (cur.timestamp !== undefined && cur.timestamp === old.timestamp)) continue;

				old.timestamp = cur.timestamp;

				raiseComponentEvents(cur.axes, old.axes, axisCodes, i, false);
				raiseComponentEvents(cur.buttons, old.buttons, buttonCodes, i, false);

				// raise events on derived component types

				var lx = cur.axes[0];
				var ly = cur.axes[1];
				var rx = cur.axes[2];
				var ry = cur.axes[3];

				var dl = Math.sqrt(lx * lx + ly * ly);
				var dr = Math.sqrt(rx * rx + ry * ry);
				var sl = dl < 1 ? 1 : 1 / dl;
				var sr = dr < 1 ? 1 : 1 / dr;

				derived[0] = lx * sl;
				derived[1] = ly * sl;
				derived[2] = rx * sr;
				derived[3] = ry * sr;

				if (result.analogNormalized) {
					normalize2DComponents(derived, 0, 1, lx, ly, dl, result.analogDeadZone);
					normalize2DComponents(derived, 2, 3, rx, ry, dr, result.analogDeadZone);
				}

				raiseComponentEvents(derived, oldDerived, derivedCodes, i, true);
			}
		}

		function raiseComponentEvents(curList, oldList, codes, deviceIndex, isDerived) {
			for (var i = 0, l = curList.length; i < l; ++i) {
				var code = codes[i];
				var componentNormalized = !isDerived;
				var alreadyNormalized = result.analogNormalized && !componentNormalized;
				var cur = curList[i].value === undefined ? curList[i] : curList[i].value;
				var old = oldList[i];
				var v = cur;
				var dv = cur - old;
				var range = 1 - result.analogDeadZone;

				if (Math.abs(dv) >= result.analogThreshold) {
					var padIndexComponent = pi.GAMEPAD + " " + deviceIndex + " " + code;

					if (Math.abs(cur) > (alreadyNormalized ? 0 : result.analogDeadZone)) {
						if (result.analogNormalized && componentNormalized) {
							v = cur > 0 ? Math.max(0, (cur - result.analogDeadZone) / range) : Math.min(0, (cur + result.analogDeadZone) / range);
							dv = v - (old > 0 ? Math.max(0, (old - result.analogDeadZone) / range) : Math.min(0, (old + result.analogDeadZone) / range));
						}

						pi.async[code] = pi.async[padIndexComponent] = cur;

						if ((Math.abs(old) <= (alreadyNormalized ? result.analogThreshold : result.analogDeadZone)) && isFocused()) {
							result.press(code);
							result.press(padIndexComponent);
						}

						result.move(code, {v: v, dv: dv});
						result.move(padIndexComponent, {v: v, dv: dv});
					} else {
						v = cur = pi.async[code] = pi.async[padIndexComponent] = 0;
						dv = -old;

						if (Math.abs(old) > 0) {
							if (result.analogNormalized && componentNormalized) {
								dv = -(old > 0 ? Math.max(0, (old - result.analogDeadZone) / range) : Math.min(0, (old + result.analogDeadZone) / range));	
							}

							result.move(code, {v: v, dv: dv});
							result.move(padIndexComponent, {v: v, dv: dv});
							result.release(code);
							result.release(padIndexComponent);
						}
					}

					oldList[i] = cur;
				}
			}
		}

		//
		// orientation
		//

		var calibration = {
				orientation: [0, 0, 0, 0],
				acceleration: [0, 0, 0, 0],
				accelerationIncludingGravity: [0, 0, 0, 0],
				rotationRate: [0, 0, 0, 0],
				positionMatrix: identityMatrix()
			};
		var oldOrientation = [0, 0, 0, 0];
		var lastReportedOrientation = [0, 0, 0, 0];

		window.addEventListener('deviceorientation', orientationInit);

		function orientationInit(e) {
			var x = pi.async[pi.MOTION_ORIENTATION_X] = (lastReportedOrientation[0] = e.beta * constants.DEGREES_TO_RADIANS) - calibration.orientation[0],
				y = pi.async[pi.MOTION_ORIENTATION_Y] = (lastReportedOrientation[1] = e.gamma * constants.DEGREES_TO_RADIANS) - calibration.orientation[1],
				z = pi.async[pi.MOTION_ORIENTATION_Z] = (lastReportedOrientation[2] = e.alpha * constants.DEGREES_TO_RADIANS) - calibration.orientation[2],
				vx = Math.cos(y),
				vy = Math.cos(x),
				vz = Math.sin(y),
				vl = Math.sqrt(vx * vx + vy * vy + vz * vz);

			oldOrientation[0] = vx / vl;
			oldOrientation[1] = vy / vl;
			oldOrientation[2] = vz / vl;

			// init angle diff between calibration vector and orientation vector
			oldOrientation[3] = 0;

			window.removeEventListener('deviceorientation', orientationInit);
			window.addEventListener('deviceorientation', orientationHandler);

			orientationHandler(e, true);
		}

		function orientationHandler(e, first) {
			// we don't extend IN.Device for this because we want to normalize multiple axes
			// that all have different input ranges 

			lastReportedOrientation[0] = e.beta * constants.DEGREES_TO_RADIANS;
			lastReportedOrientation[1] = e.gamma * constants.DEGREES_TO_RADIANS;
			lastReportedOrientation[2] = e.alpha * constants.DEGREES_TO_RADIANS;

			var x = lastReportedOrientation[0] - calibration.orientation[0],
				y = lastReportedOrientation[1] - calibration.orientation[1],
				z = lastReportedOrientation[2] - calibration.orientation[2],
				vx = Math.cos(y),
				vy = Math.sin(x),
				vz = Math.sin(y),
				vl = Math.sqrt(vx * vx + vy * vy + vz * vz),
				xOld = pi.async[pi.MOTION_ORIENTATION_X],
				yOld = pi.async[pi.MOTION_ORIENTATION_Y],
				zOld = pi.async[pi.MOTION_ORIENTATION_Z],
				dx,
				dy,
				dz,
				vxOld = oldOrientation[0],
				vyOld = oldOrientation[1],
				vzOld = oldOrientation[2],
				angleDiff;

			// update position matrix!

			buildRotationMatrix(x, y, z, result.positionMatrix);

			// x/y orientation handling

			vx /= vl;
			vy /= vl;
			vz /= vl;

			// measure of angle between this and last x/y orientation
			angleDiff = Math.acos(Math.max(-1, Math.min(1, vx * vxOld + vy * vyOld + vz * vzOld)));

			if (first || angleDiff > result.orientationXYThreshold) {
				var vxNeutral = Math.cos(calibration.orientation[1]),
					vyNeutral = Math.sin(calibration.orientation[0]),
					vzNeutral = Math.sin(calibration.orientation[1]),
					vlNeutral = Math.sqrt(vxNeutral * vxNeutral + vyNeutral * vyNeutral + vzNeutral * vzNeutral),
					angleFromCenter,
					angleRangeX = Math.PI - result.orientationXYDeadZone,
					angleRangeY = constants.HALF_PI - result.orientationXYDeadZone;

				vxNeutral /= vlNeutral;
				vyNeutral /= vlNeutral;
				vzNeutral /= vlNeutral;

				// measure of angle between x/y orientation and "neutral" calibration position
				angleFromCenter = Math.acos(Math.max(-1, Math.min(1, vx * vxNeutral + vy * vyNeutral + vz * vzNeutral)));

				// wrap x and y to the proper range
				if (x > Math.PI) x = x % Math.PI - Math.PI;
				else if (x < -Math.PI) x = Math.PI + x % Math.PI;
				if (y > constants.HALF_PI) y = y % constants.HALF_PI - constants.HALF_PI;
				else if (y < -constants.HALF_PI) y = constants.HALF_PI + y % constants.HALF_PI;

				if (xOld > Math.PI) xOld = xOld % Math.PI - Math.PI;
				else if (xOld < -Math.PI) xOld = Math.PI + xOld % Math.PI;
				if (yOld > constants.HALF_PI) yOld = yOld % constants.HALF_PI - constants.HALF_PI;
				else if (yOld < -constants.HALF_PI) yOld = constants.HALF_PI + yOld % constants.HALF_PI;

				dx = x - xOld;
				dy = y - yOld;

				if (Math.abs(x) > constants.HALF_PI || angleFromCenter > result.orientationXYDeadZone) {
					if (first || oldOrientation[3] <= result.orientationXYDeadZone) {
						result.press(pi.MOTION_ORIENTATION_X);
						result.press(pi.MOTION_ORIENTATION_Y);
					}

					if (result.orientationXYNormalized) {
						x = x > 0 ? Math.max(0, (x - result.orientationXYDeadZone) / angleRangeX) : Math.min(0, (x + result.orientationXYDeadZone) / angleRangeX);
						y = y > 0 ? Math.max(0, (y - result.orientationXYDeadZone) / angleRangeY) : Math.min(0, (y + result.orientationXYDeadZone) / angleRangeY);
						dx = x - (xOld > 0 ? Math.max(0, (xOld - result.orientationXYDeadZone) / angleRangeX) : Math.min(0, (xOld + result.orientationXYDeadZone) / angleRangeX));
						dy = y - (yOld > 0 ? Math.max(0, (yOld - result.orientationXYDeadZone) / angleRangeY) : Math.min(0, (yOld + result.orientationXYDeadZone) / angleRangeY));
					}

					result.move(pi.MOTION_ORIENTATION_X, { v: x, dv: dx });
					result.move(pi.MOTION_ORIENTATION_Y, { v: y, dv: dy });
				} else {
					dx = -x;
					dy = -y;
					x = y = 0;

					if (oldOrientation[3] >= result.orientationXYDeadZone) {
						if (result.orientationXYNormalized) {
							dx = -(xOld > 0 ? Math.max(0, (xOld - result.orientationXYDeadZone) / angleRangeX) : Math.min(0, (xOld + result.orientationXYDeadZone) / angleRangeX));
							dy = -(yOld > 0 ? Math.max(0, (yOld - result.orientationXYDeadZone) / angleRangeY) : Math.min(0, (yOld + result.orientationXYDeadZone) / angleRangeY));
						}

						result.move(pi.MOTION_ORIENTATION_X, { v: x, dv: dx });
						if (!first) result.release(pi.MOTION_ORIENTATION_X);
						
						result.move(pi.MOTION_ORIENTATION_Y, { v: y, dv: dy });
						if (!first) result.release(pi.MOTION_ORIENTATION_X);
					}
				}

				// what was new is old again
				// TODO will this work after recalibration?
				oldOrientation[0] = vx;
				oldOrientation[1] = vy;
				oldOrientation[2] = vz;
				oldOrientation[3] = angleFromCenter;

				// store non-normalized values in async table
				pi.async[pi.MOTION_ORIENTATION_X] = x;
				pi.async[pi.MOTION_ORIENTATION_Y] = y;
			}

			// z orientation handling

			if (z > constants.DOUBLE_PI) z = z % constants.DOUBLE_PI - constants.DOUBLE_PI;
			else if (z < -constants.DOUBLE_PI) z = constants.DOUBLE_PI + z % constants.DOUBLE_PI;
			if (zOld > constants.DOUBLE_PI) zOld = zOld % constants.DOUBLE_PI - constants.DOUBLE_PI;
			else if (zOld < -constants.DOUBLE_PI) zOld = constants.DOUBLE_PI + zOld % constants.DOUBLE_PI;

			dz = z - zOld;

			var zDiff = Math.abs(dz);

			if (first || zDiff > result.orientationZThreshold) {
				var angleRangeZ = constants.DOUBLE_PI - result.orientationZDeadZone;

				if (Math.abs(z) > result.orientationZDeadZone) {
					if (first || Math.abs(zOld) <= result.orientationZDeadZone) {
						result.press(pi.MOTION_ORIENTATION_Z);
					}

					if (result.orientationZNormalized) {
						z = z > 0 ? Math.max(0, (z - result.orientationZDeadZone) / angleRangeZ) : Math.min(0, (z + result.orientationZDeadZone) / angleRangeZ);
						dz = z - (zOld > 0 ? Math.max(0, (zOld - result.orientationZDeadZone) / angleRangeZ) : Math.min(0, (zOld + result.orientationZDeadZone) / angleRangeZ));
					}

					result.move(pi.MOTION_ORIENTATION_Z, { v: z, dv: dz });
				} else {
					z = 0;
					dz = -zOld;

					if (Math.abs(zOld) > result.orientationZDeadZone) {
						if (result.orientationZNormalized) {
							dz = -(zOld > 0 ? Math.max(0, (zOld - result.orientationZDeadZone) / angleRangeZ) : Math.min(0, (zOld + result.orientationZDeadZone) / angleRangeZ));
						}

						result.move(pi.MOTION_ORIENTATION_Z, { v: z, dv: dz });
						if (!first) result.release(pi.MOTION_ORIENTATION_Z);
					}
				}

				// update "old" values

				pi.async[pi.MOTION_ORIENTATION_Z] = z;
			}
		}

		//
		// motion
		//

		var motionInterval;
		var deltaSeconds;

		var acceleration = [0, 0, 0, 0];
		var accelerationIncludingGravity = [0, 0, 0, 0];

		var rotationRate = [0, 0, 0, 0];
		var transformedAcceleration = [0, 0, 0, 0];

		var oldVelocityDelta = [0, 0, 0, 0];
		var velocityDelta = [0, 0, 0, 0];
		var velocity = [0, 0, 0, 0];

		var oldPositionDelta = [0, 0, 0, 0];
		var positionDelta = [0, 0, 0, 0];
		var position = [0, 0, 0, 0];

		var oldAcceleration = [0, 0, 0, 0];
		var oldAccelerationIncludingGravity = [0, 0, 0, 0];
		var oldRotationRate = [0, 0, 0, 0];

		var lastReportedAcceleration = [0, 0, 0, 0];
		var lastReportedAccelerationIncludingGravity = [0, 0, 0, 0];
		var lastReportedRotationRate = [0, 0, 0, 0];

		window.addEventListener('devicemotion', motionInit);

		function identityMatrix() {
			return [
				1, 0, 0, 0,
				0, 1, 0, 0,
				0, 0, 1, 0,
				0, 0, 0, 1
			];
		}

		function buildRotationMatrix(x, y, z, result) {
			var cx = Math.cos(x),
				sx = Math.sin(x),
				cy = Math.cos(y),
				sy = Math.sin(y),
				cz = Math.cos(z),
				sz = Math.sin(z),
				cycz = cy * cz,
				cysz = cy * sz;

			result[0] = cx * cycz - sx * sz;
			result[1] = cx * cysz + sx * cz;
			result[2] = -cx * sy;

			result[4] = -sx * cycz - cx * sz;
			result[5] = -sx * cysz + cx * cz;
			result[6] = sx * sy;

			result[8] = sy * cz;
			result[9] = sy * sz;
			result[10] = cy;
		}

		function multiplyMatrixByVector(m, v, result) {
			// TODO test row/column cardinality
			result[0] = m[0] * v[0] + m[1] * v[1] + m[2] * v[2] + m[3];
			result[1] = m[4] * v[0] + m[5] * v[1] + m[6] * v[2] + m[7];
			result[2] = m[8] * v[0] + m[9] * v[1] + m[10] * v[2] + m[11];
		}

		function copyVector(src, dst) {
			dst[0] = src[0];
			dst[1] = src[1];
			dst[2] = src[2];
			dst[3] = src[3];
		}

		function scaleVector(v, s, result) {
			result[0] = v[0] * s;
			result[1] = v[1] * s;
			result[2] = v[2] * s;
			result[3] = v[3] * s;
		}

		function subtractVectors(a, b, result) {
			result[0] = a[0] - b[0];
			result[1] = a[1] - b[1];
			result[2] = a[2] - b[2];
		}

		function addVectors(a, b, result) {
			result[0] = a[0] + b[0];
			result[1] = a[1] + b[1];
			result[2] = a[2] + b[2];
		}

		function vectorMagnitude(v) {
			return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
		}

		// TODO can actually factor this cleanly

		function motionInit(e) {
			motionInterval = e.interval || 0;
			deltaSeconds = motionInterval / 1000;

			pi.async[pi.MOTION_ACCELERATION_X] = (lastReportedAcceleration[0] = e.acceleration.x) - calibration.acceleration[0];
			pi.async[pi.MOTION_ACCELERATION_Y] = (lastReportedAcceleration[1] = e.acceleration.y) - calibration.acceleration[1];
			pi.async[pi.MOTION_ACCELERATION_Z] = (lastReportedAcceleration[2] = e.acceleration.z) - calibration.acceleration[2];
			
			pi.async[pi.MOTION_ACCELERATION_WITH_GRAVITY_X] = (lastReportedAccelerationIncludingGravity[0] = e.accelerationIncludingGravity.x) - calibration.accelerationIncludingGravity[0];
			pi.async[pi.MOTION_ACCELERATION_WITH_GRAVITY_Y] = (lastReportedAccelerationIncludingGravity[1] = e.accelerationIncludingGravity.y) - calibration.accelerationIncludingGravity[1];
			pi.async[pi.MOTION_ACCELERATION_WITH_GRAVITY_Z] = (lastReportedAccelerationIncludingGravity[2] = e.accelerationIncludingGravity.z) - calibration.accelerationIncludingGravity[2];
			
			pi.async[pi.MOTION_ROTATION_X] = (lastReportedRotationRate[0] = e.rotationRate.gamma) - calibration.rotationRate[0];
			pi.async[pi.MOTION_ROTATION_Y] = (lastReportedRotationRate[1] = e.rotationRate.beta) - calibration.rotationRate[1];
			pi.async[pi.MOTION_ROTATION_Z] = (lastReportedRotationRate[2] = e.rotationRate.alpha) - calibration.rotationRate[2];

			pi.async[pi.MOTION_ACCELERATION_MAGNITUDE] = vectorMagnitude(lastReportedAcceleration);
			pi.async[pi.MOTION_ACCELERATION_INCLUDING_GRAVITY_MAGNITUDE] = vectorMagnitude(lastReportedAccelerationIncludingGravity);
			pi.async[pi.MOTION_ROTATION_MAGNITUDE] = vectorMagnitude(lastReportedRotationRate);

			pi.async[pi.MOTION_VELOCITY_X] = velocity[0] += acceleration[0] * deltaSeconds;
			pi.async[pi.MOTION_VELOCITY_Y] = velocity[1] += acceleration[1] * deltaSeconds;
			pi.async[pi.MOTION_VELOCITY_Z] = velocity[2] += acceleration[2] * deltaSeconds;
			pi.async[pi.MOTION_VELOCITY_MAGNITUDE] = vectorMagnitude(velocity);

			pi.async[pi.MOTION_POSITION_X] = 0;
			pi.async[pi.MOTION_POSITION_Y] = 0;
			pi.async[pi.MOTION_POSITION_Z] = 0;
			pi.async[pi.MOTION_POSITION_MAGNITUDE] = 0;

			window.removeEventListener('devicemotion', motionInit);
			window.addEventListener('devicemotion', motionHandler);

			motionHandler(e, true);
		}

		function motionHandler(e, first) {
			motionInterval = e.interval || 0;
			deltaSeconds = motionInterval / 1000;

			lastReportedAcceleration[0] = e.acceleration.x;
			lastReportedAcceleration[1] = e.acceleration.y;
			lastReportedAcceleration[2] = e.acceleration.z;
			
			lastReportedAccelerationIncludingGravity[0] = e.accelerationIncludingGravity.x;
			lastReportedAccelerationIncludingGravity[1] = e.accelerationIncludingGravity.y;
			lastReportedAccelerationIncludingGravity[2] = e.accelerationIncludingGravity.z;

			if (result.accelerationFilter instanceof Array) {
				for (var i = 0; i < result.accelerationFilter.length; ++i) {
					if (typeof result.accelerationFilter[i] === 'function') result.accelerationFilter[i](lastReportedAcceleration);
				}
			}

			if (result.accelerationIncludingGravityFilter instanceof Array) {
				for (var i = 0; i < result.accelerationIncludingGravityFilter.length; ++i) {
					if (typeof result.accelerationIncludingGravityFilter[i] === 'function') result.accelerationIncludingGravityFilter[i](lastReportedAccelerationIncludingGravity);
				}
			}

			lastReportedRotationRate[0] = e.rotationRate.alpha;
			lastReportedRotationRate[1] = e.rotationRate.beta;
			lastReportedRotationRate[2] = e.rotationRate.gamma;

			if (typeof result.rotationFilter === 'function') result.rotationFilter(lastReportedRotationRate);

			// adjust for calibration

			subtractVectors(lastReportedAcceleration, calibration.acceleration, acceleration);
			subtractVectors(lastReportedAccelerationIncludingGravity, calibration.accelerationIncludingGravity, accelerationIncludingGravity);
			subtractVectors(lastReportedRotationRate, calibration.rotationRate, rotationRate);

			acceleration[3] = vectorMagnitude(lastReportedAcceleration);
			accelerationIncludingGravity[3] = vectorMagnitude(lastReportedAccelerationIncludingGravity);
			rotationRate[3] = vectorMagnitude(lastReportedRotationRate);

			handle3DMotion(acceleration, accelerationCodes, result.accelerationDeadZone, result.accelerationThreshold, first);
			handle3DMotion(accelerationIncludingGravity, accelerationIncludingGravityCodes, result.accelerationIncludingGravityDeadZone, result.accelerationIncludingGravityThreshold, first);
			handle3DMotion(rotationRate, rotationRateCodes, result.rotationDeadZone, result.rotationThreshold, first);

			// free-orientation derived velocity based on calibrated motion/orientation

			multiplyMatrixByVector(result.positionMatrix, acceleration, transformedAcceleration);

			if (acceleration[3] > result.accelerationDeadZone) {
				scaleVector(/*transformedA*/acceleration, deltaSeconds, velocityDelta);
				addVectors(velocity, velocityDelta, velocity);

				if (result.velocityFilter instanceof Array) {
					for (var i = 0; i < result.velocityFilter.length; ++i) {
						if (typeof result.velocityFilter[i] === 'function') result.velocityFilter[i](lastReportedAcceleration);
					}
				}
			} else {
				scaleVector(velocity, 0.5, velocity);
			}

			velocity[3] = vectorMagnitude(velocity);
			handle3DMotion(velocity, velocityCodes, result.velocityDeadZone, result.velocityThreshold, first);

			if (velocity[3] > result.velocityDeadZone) {
				scaleVector(velocity, deltaSeconds, positionDelta);
				addVectors(position, positionDelta, position);

				if (typeof result.positionFilter === 'function') result.positionFilter(positionDelta);

				position[3] = vectorMagnitude(position);

				handle3DMotion(position, positionCodes, result.positionDeadZone, result.positionThreshold, first);
			}
		}

		function handle3DMotion(values, codes, deadZone, threshold, first) {
			var magnitude = values[3];
			var oldMagnitude = pi.async[codes[3]];
			var i;

			if (!first && Math.abs(magnitude - oldMagnitude) < threshold) return;

			if (magnitude >= deadZone) {

				for (i = 0; i < 4; ++i) {
					if (first || oldMagnitude < deadZone) pi.press(codes[i]);
					pi.move(codes[i], { v: values[i], dv: values[i] - pi.async[codes[i]] });
					pi.async[codes[i]] = values[i];
				}
			} else if (oldMagnitude >= deadZone) {
				for (i = 0; i < 4; ++i) {
					values[i] = 0;
					pi.move(codes[i], { v: 0, dv: -pi.async[codes[i]] });
					if (!first) pi.release(codes[i]);
					pi.async[codes[i]] = values[i];
				}
			}
		}

		// mouse

		function mouseMove(e) {
			if (!isFocused()) return;
			pi.Mouse.position.x = e.pageX;
			pi.Mouse.position.y = e.pageY;

			var dx, dy;

			dx = e.movementX || e.webkitMovementX || e.mozMovementX;
			dy = e.movementY || e.webkitMovementY || e.mozMovementY;

			if (dx === undefined || dy === undefined) {
				dx = (oldMX !== undefined) && (e.offsetX - oldMX) || 0;
				dy = (oldMY !== undefined) && (e.offsetY - oldMY) || 0;
				oldMX = e.offsetX;
				oldMY = e.offsetY;
			}

			result.move(
				pi.MOUSE_MOVE,
				{
					x: e.offsetX,
					y: e.offsetY,
					dx: dx,
					dy: dy
				}
			);
		}

		function mouseDown(e) {
			if (!isFocused()) return;
			var pressedButton = buttonToComponent[e.which];
			pi.async[pressedButton] = true;

			result.press(pressedButton);
			result.move(pressedButton, {v:1,dv:1});

			if (e.which !== 2) {
				return !!result.allowDrag;
			} else if (!result.middleClickScroll) {
				UTILS.killEvent(e);
				return false;
			}
		}

		function mouseUp(e) {
			var pressedButton = buttonToComponent[e.which];

			delete pi.async[pressedButton];

			result.move(pressedButton, {v:0,dv:-1});
			result.release(pressedButton);
		}

		function mouseScroll(e) {
			if (!isFocused()) return;
			var val = -e.wheelDelta || e.detail;
			var d, code;

			if (val < 0) {
				code = pi.MOUSE_SCROLL_UP;
				d = -1;
			} else {
				code = pi.MOUSE_SCROLL_DOWN;
				d = 1;
			}
			
			result.press(code);
			result.move(code, {v:val,dv:d});
			result.release(code);
		}

		// keyboard
		
		function keyDown(e) {
			if (!isFocused()) return;

			var pressedKey = keyCodeToComponent[e.keyCode];

			if (!keyIsPressed[e.keyCode]) {
				keyIsPressed[e.keyCode] = true;

				pi.async[pressedKey] = true;

				result.press(pressedKey);
				result.move(pressedKey, {v:1,dv:1});
			}

			if (result.allowDefaultKeyboardEvents) return true;
			e.preventDefault();
			return false;
		}

		function keyUp(e) {
			var pressedKey = keyCodeToComponent[e.keyCode];

			keyIsPressed[e.keyCode] = undefined;
			delete pi.async[pressedKey];

			result.move(pressedKey, {v:0,dv:-1});
			result.release(pressedKey);

			if (result.allowDefaultKeyboardEvents) return true;
			e.preventDefault();
			return false;
		}

		function keyPress(e) {
			if (result.allowDefaultKeyboardEvents) return true;
			e.preventDefault();
			return false;
		}

		// misc default behavior preventers

		function contextMenu(e) {
			if (result.allowContextMenu) return true;
			e.preventDefault();
			return false;
		}

		function dragStart(e) {
			if (result.allowDrag) return true;
			e.preventDefault();
			return false;
		}

		function selectStart(e) {
			if (result.allowSelect) return true;
			e.preventDefault();
			return false;
		}

		// listener helpers

		function addDOMListeners() {
			// if the target is the document body, listen on document so we can trap events outside the body also
			if ((DOMElement = oldTargetElement) === document.body) DOMElement = document;

			DOMElement.addEventListener("mousemove", mouseMove);
			DOMElement.addEventListener("mousedown", mouseDown);
			document.addEventListener("mouseup", mouseUp);
			DOMElement.addEventListener("dragend", mouseUp);
			DOMElement.addEventListener("mousewheel", mouseScroll);
			DOMElement.addEventListener("DOMMouseScroll", mouseScroll);

			document.addEventListener("keydown", keyDown);
			document.addEventListener("keyup", keyUp);
			document.addEventListener("keypress", keyPress);

			DOMElement.addEventListener("contextmenu", contextMenu);
			DOMElement.addEventListener("dragstart", dragStart);
			DOMElement.addEventListener("selectstart", selectStart);
		}

		function removeDOMListeners() {
			DOMElement.removeEventListener("mousemove", mouseMove);
			DOMElement.removeEventListener("mousedown", mouseDown);
			document.removeEventListener("mouseup", mouseUp);
			DOMElement.removeEventListener("dragend", mouseUp);
			DOMElement.removeEventListener("mousewheel", mouseScroll);
			DOMElement.removeEventListener("DOMMouseScroll", mouseScroll);

			document.removeEventListener("keydown", keyDown);
			document.removeEventListener("keyup", keyUp);
			document.removeEventListener("keypress", keyPress);

			DOMElement.removeEventListener("contextmenu", contextMenu);
			DOMElement.removeEventListener("dragstart", dragStart);
			DOMElement.removeEventListener("selectstart", selectStart);
		}

		addDOMListeners();

		var result = {
			enabled: args && args.enabled !== undefined ? args.enabled : defaults.dispatcherEnabled,
			autoPoll: args && args.autoPoll !== undefined ? args.autoPoll : defaults.autoPoll,
			pollRate: oldPollRate,
			
			analogDeadZone: Math.max(0.00001, args && args.analogDeadZone !== undefined ? args.analogDeadZone : defaults.analogDeadZone),
			analogThreshold: args && args.analogThreshold !== undefined ? args.analogThreshold : defaults.analogThreshold,
			analogNormalized: args && args.analogNormalized !== undefined ? args.analogNormalized : defaults.analogNormalized,
			
			orientationXYDeadZone: args && args.orientationXYDeadZone !== undefined ? args.orientationXYDeadZone : defaults.orientationXYDeadZone,
			orientationZDeadZone: args && args.orientationZDeadZone !== undefined ? args.orientationZDeadZone : defaults.orientationZDeadZone,
			orientationXYThreshold: args && args.orientationXYThreshold !== undefined ? args.orientationXYThreshold : defaults.orientationXYThreshold,
			orientationZThreshold: args && args.orientationZThreshold !== undefined ? args.orientationZThreshold : defaults.orientationZThreshold,
			orientationXYNormalized: args && args.orientationXYNormalized !== undefined ? args.orientationXYNormalized : defaults.orientationXYNormalized,
			orientationZNormalized: args && args.orientationZNormalized !== undefined ? args.orientationZNormalized : defaults.orientationZNormalized,
			
			accelerationDeadZone: args && args.accelerationDeadZone !== undefined ? args.accelerationDeadZone : defaults.accelerationDeadZone,
			accelerationThreshold: args && args.accelerationThreshold !== undefined ? args.accelerationThreshold : defaults.accelerationThreshold,
			accelerationFilter: args && args.accelerationFilter !== undefined ? args.accelerationFilter : defaults.accelerationFilter,

			accelerationIncludingGravityDeadZone: args && args.accelerationIncludingGravityDeadZone !== undefined ? args.accelerationIncludingGravityDeadZone : defaults.accelerationIncludingGravityDeadZone,
			accelerationIncludingGravityThreshold: args && args.accelerationIncludingGravityThreshold !== undefined ? args.accelerationIncludingGravityThreshold : defaults.accelerationIncludingGravityThreshold,
			accelerationIncludingGravityFilter: args && args.accelerationIncludingGravityFilter !== undefined ? args.accelerationIncludingGravityFilter : defaults.accelerationIncludingGravityFilter,

			rotationDeadZone: args && args.rotationDeadZone !== undefined ? args.rotationDeadZone : defaults.rotationDeadZone,
			rotationThreshold: args && args.rotationThreshold !== undefined ? args.rotationThreshold : defaults.rotationThreshold,
			rotationFilter: args && args.rotationFilter !== undefined ? args.rotationFilter : defaults.rotationFilter,

			velocityDeadZone: args && args.velocityDeadZone !== undefined ? args.velocityDeadZone : defaults.velocityDeadZone,
			velocityThreshold: args && args.velocityThreshold !== undefined ? args.velocityThreshold : defaults.velocityThreshold,
			velocityFilter: args && args.velocityFilter !== undefined ? args.velocityFilter : defaults.velocityFilter,

			positionDeadZone: args && args.positionDeadZone !== undefined ? args.positionDeadZone : defaults.positionDeadZone,
			positionThreshold: args && args.positionThreshold !== undefined ? args.positionThreshold : defaults.positionThreshold,
			positionFilter: args && args.positionFilter !== undefined ? args.positionFilter : defaults.positionFilter,

			// TODO pros/cons of exposing this here? 

			positionMatrix: identityMatrix(),

			allowContextMenu: args && args.allowContextMenu !== undefined ? args.allowContextMenu : defaults.allowContextMenu,
			allowMiddleMouseScroll: args && args.allowMiddleMouseScroll !== undefined ? args.allowMiddleMouseScroll : defaults.allowMiddleMouseScroll,
			allowSelect: args && args.allowSelect !== undefined ? args.allowSelect : defaults.allowSelect,
			allowDrag: args && args.allowDrag !== undefined ? args.allowDrag : defaults.allowDrag,
			allowFocusOnHover: args && args.allowFocusOnHover !== undefined ? args.allowFocusOnHover : defaults.allowFocusOnHover,
			allowDefaultKeyboardEvents: args && args.allowDefaultKeyboardEvents !== undefined ? args.allowDefaultKeyboardEvents : defaults.allowDefaultKeyboardEvents,
			
			element: oldTargetElement,
			
			press: function(component, time) {
				if (result.enabled) raiseEvents(result, listeners[component], beforePress, component, time);
			},
			hold: function(component, duration, time) {
				if (result.enabled) raiseEvents(result, listeners[component], beforeHold, component, time, duration);
			},
			release: function(component, duration, time) {
				if (result.enabled) raiseEvents(result, listeners[component], beforeRelease, component, time, duration);
			},
			move: function(component, args, time) {
				if (result.enabled) raiseEvents(result, listeners[component], beforeMove, component, time, args);
			},
			bind: function(args) {
				var binding = {
					dispatcher: result,
					control: args.control,
					moveArgs: args.moveArgs,
					target: args.target,
					timePressed: {}
				};
				
				modifyListeners(addListener, listeners, args.component, binding, args.prepend);
				return binding;
			},
			unbind: function(args) {
				modifyListeners(removeListener, listeners, args.component, {control: args.control}, args.prepend);
			},
			rebind: function(args) {
				if (rebindTarget.control !== undefined || !args.control) return false;

				rebindTarget.control = args.control;
				rebindTarget.oldDeadZone = this.analogDeadZone;

				this.analogDeadZone = 0.625;
				this.unbind(args);
				this.bind({control: rebindControl});

				return true;
			},
			requestPointerLock: function(onEnter, onExit) {
				oldTargetElement.requestPointerLock = oldTargetElement.requestPointerLock || oldTargetElement[UTILS.getMember(oldTargetElement, ["webkitRequestPointerLock", "mozRequestPointerLock"])];
				onEnterPointerLock = onEnter;
				onExitPointerLockElement = onExit;
				onExitPointerLock = undefined;
				oldTargetElement.requestPointerLock();
			},
			exitPointerLock: function(onExit) {
				if (pointerLockElement === oldTargetElement) IN.Mouse.exitPointerLock(onExit);
			},
			calibrateOrientation: function(x, y, z) {
				if (x !== false) calibration.orientation[0] = (x === undefined || x === true) ? lastReportedOrientation[0] : x;
				if (y !== false) calibration.orientation[1] = (y === undefined || y === true) ? lastReportedOrientation[1] : y;
				if (z !== false) calibration.orientation[2] = (z === undefined || z === true) ? lastReportedOrientation[2] : z;
			},
			calibrateAcceleration: function(x, y, z) {
				// TODO measure effects on velocity? maybe need to calibrate that separately
				if (x !== false) calibration.acceleration[0] = (x === undefined || x === true) ? lastReportedAcceleration[0] : x;
				if (y !== false) calibration.acceleration[1] = (y === undefined || y === true) ? lastReportedAcceleration[1] : y;
				if (z !== false) calibration.acceleration[2] = (z === undefined || z === true) ? lastReportedAcceleration[2] : z;
			},
			calibratePosition: function(x, y, z) {
				if (x !== false) calibration.positionMatrix[4] = (x === undefined || x === true) ? position[0] : x;
				if (y !== false) calibration.positionMatrix[8] = (y === undefined || y === true) ? position[1] : y;
				if (z !== false) calibration.positionMatrix[12] = (z === undefined || z === true) ? position[2] : z;
			},
			poll: function() {
				// see if result.element changed on us
				if (oldTargetElement !== result.element) {
					removeDOMListeners();
					oldTargetElement = result.element = (result.element !== document && result.element || document.body);
					addDOMListeners();
				}

				if (!result.enabled) return;

				// raise hold events on active components
				for (var component in pi.async) this.hold(component);

				pollGamepads();
			}
		};

		dispatchers.push(result);
		return result;
	},
	Control: function(args) {
		return {
			enabled: args && args.enabled !== undefined ? args.enabled : defaults.controlEnabled,
			move: args.move,
			press: args.press,
			hold: args.hold,
			release: args.release
		};
	},
	Device: function(args) {
		var newValues = {},
			components = args && typeof args.components === 'object' ? args.components : {COMPONENT: 'Component'},
			componentSettings = {},
			result = {
				enabled: args && args.enabled !== undefined ? args.enabled : defaults.deviceEnabled,
				normalized: args && args.normalized !== undefined ? args.normalized : defaults.deviceNormalized,
				id: userDeviceId,
				events: args && args.events || {},
				pollRate: args && args.pollRate !== undefined ? args.pollrate : defaults.devicePollRate,
				poll: args && args.poll || undefined,
				DEVICE: args && args.name !== undefined ? args.name : ('User-Defined Device ' + userDeviceId),
				deadZone: Math.max(0.00001, args && args.deadZone !== undefined ? args.deadZone : defaults.deviceDeadZone),
				threshold: args && args.threshold !== undefined ? args.threshold : defaults.deviceThreshold
			},
			eventContext = {
				values: newValues,
				device: result,
				event: undefined
			};

		++userDeviceId;

		// helpers

		function raiseEvents() {
			if (!result.enabled || result.deadZone >= 1) return;

			for (var c in newValues) {
				var component = result[c],
					componentNormalized = componentSettings[component].normalized,
					alreadyNormalized = result.normalized && !componentNormalized,
					old = pi.async[component],
					cur = newValues[c],
					diff = cur - old,
					v,
					dv,
					range = 1 - result.deadZone;

				if (Math.abs(diff) >= result.threshold) {
					range = 1 - result.deadZone;

					if (Math.abs(cur) > (alreadyNormalized ? 0 : result.deadZone)) {
						if (Math.abs(old) <= (alreadyNormalized ? result.threshold : result.deadZone)) pi.press(component);

						v = cur;
						dv = diff;

						if (result.normalized && componentNormalized) {
							v = cur > 0 ? Math.max(0, (cur - result.deadZone) / range) : Math.min(0, (cur + result.deadZone) / range);
							dv = v - (old > 0 ? Math.max(0, (old - result.deadZone) / range) : Math.min(0, (old + result.deadZone) / range));
						}

						pi.move(component, {v: v, dv: dv});
					} else {
						cur = v = 0;
						dv = diff = -old;

						if (Math.abs(old) > 0) {
							if (result.normalized && componentNormalized) {
								dv = -(old > 0 ? Math.max(0, (old - result.deadZone) / range) : Math.min(0, (old + result.deadZone) / range));	
							}

							pi.move(component, {v: v, dv: dv});
							pi.release(component);
						}
					}

					// update async table
					pi.async[component] = cur;
				}
			}
		}

		// add component codes and settings to stuff
		for (var c in components) {
			var componentName = typeof components[c] === 'object' ? components[c].name : components[c];

			componentName = result[c] = result.DEVICE + ' ' + componentName;
			
			componentSettings[componentName] = {
				normalized: components[c].normalized !== undefined ? components[c].normalized : defaults.deviceComponentNormalized
			}

			componentToDevice[componentName] = result.DEVICE;
			newValues[c] = pi.async[componentName] = 0;
		}

		// listen for events
		for (var eventName in result.events) {
			var e = result.events[eventName];
			if (typeof e.callback === 'function') (e.target || document).addEventListener(eventName, (function(e){
				return function(event) {
					eventContext.event = event;
					var callbackResult = e.callback(eventContext);
					if (callbackResult === undefined || callbackResult) raiseEvents();
				};
			}(e)), e.capture || defaults.deviceCapture);
		}

		// call user's own init func
		if (args && typeof args.init === 'function') args.init.call(result, eventContext);

		if (typeof result.poll === 'function') setInterval(function() {
			eventContext.event = undefined;
			var pollResult = result.poll(eventContext);
			if (pollResult === undefined || pollResult) raiseEvents();
		}, result.pollRate);

		return result;
	},
	TouchArea: function(args) {
		// construct a new TouchArea by extending a Device object
		var touchListener = { 
			target: args && args.element,
			callback: touchHandler
		};

		// construct device
		var result = new IN.Device({
			name: args && args.name,
			deadZone: args && typeof args.deadZone !== 'undefined' ? args.deadZone : defaults.touchDeadZone,
			threshold: args && typeof args.threshold !== 'undefined' ? args.threshold : defaults.touchThreshold,
			normalized: args && typeof args.normalized !== 'undefined' ? args.normalized : defaults.touchNormalized,
			events: {
				touchstart: touchListener,
				touchmove: touchListener,
				touchend: touchListener,
				touchleave: touchListener,
				touchcancel: touchListener
			},
			components: {
				SLIDER_X: 'Slider X',
				SLIDER_Y: 'Slider Y',
				MANHATTAN_X: 'Manhattan X',
				MANHATTAN_Y: 'Manhattan Y',
				RADIAL_X: {
					name: 'Radial X',
					normalized: false
				},
				RADIAL_Y: {
					name: 'Radial Y',
					normalized: false
				},
				PRESSURE: 'Pressure'
			},
			init: function(e) {
				e.touchOrigin = {x: 0, y: 0};
			}
		});

		// extended properties
		result.element = touchListener.target;
		result.allowScrolling = args && args.allowScrolling !== undefined && args.allowScrolling || defaults.touchAllowScrolling;
		result.snap = args && args.snap !== undefined ? args.snap : defaults.touchSnap;
		result.floatOrigin = args && args.floatOrigin !== undefined ? args.floatOrigin : defaults.touchFloatOrigin;
		result.allowScrolling = args && args.allowScrolling !== undefined ? args.allowScrolling : defaults.touchAllowScrolling;

		function touchHandler(e) {
			if (result.snap && (e.event.type === 'touchend' || e.event.type === 'touchcancel')) {
				e.values.PRESSURE = 0;
				e.values.SLIDER_X = e.values.SLIDER_Y = 0;
				e.values.MANHATTAN_X = e.values.MANHATTAN_Y = 0;
				e.values.RADIAL_X = e.values.RADIAL_Y = 0;
			} else {
				var rect = result.element.getBoundingClientRect();
				var xCenter = (rect.left + rect.right) / 2;
				var yCenter = (rect.top + rect.bottom) / 2;

				var touch = e.event.targetTouches[e.event.targetTouches.length - 1];
				var x = (touch.clientX - rect.left) / rect.width;
				var y =  (touch.clientY - rect.top) / rect.height;

				e.values.PRESSURE = touch.force;
				e.values.SLIDER_X = Math.min(1, Math.max(0, x));
				e.values.SLIDER_Y = Math.min(1, Math.max(0, y));

				var rx = x + x - 1;
				var ry = y + y - 1;

				if (e.event.type === 'touchstart') {
					if (result.floatOrigin) {
						e.touchOrigin.x = rx;
						e.touchOrigin.y = ry;
					} else {
						e.touchOrigin.x = e.touchOrigin.y = 0;
					}
				}

				rx = rx - e.touchOrigin.x;
				ry = ry - e.touchOrigin.y;

				e.values.MANHATTAN_X = Math.min(1, Math.max(-1, rx));
				e.values.MANHATTAN_Y = Math.min(1, Math.max(-1, ry));

				// maximum vector length (from center) of 1
				var d = Math.sqrt(rx * rx + ry * ry),
					scale = d <= 1 ? 1 : 1 / d;

				e.values.RADIAL_X = rx * scale;
				e.values.RADIAL_Y = ry * scale;

				if (result.normalized) {
					// manual normalization for RADIAL_X and Y, since they 
					// must be normalized relative to each other
					normalize2DComponents(e.values, 'RADIAL_X', 'RADIAL_Y', rx, ry, d, result.deadZone);
				}
			}

			if (!result.allowScrolling) UTILS.killEvent(e.event);
		}

		return result;
	},
	Filter: {
		Ramp: function(alpha) { 
			var old = [0, 0, 0],
				t = alpha || (pi.motionInterval / 1000),
				u = 1 - t;

			return function(v) {
				if (v[0] === null) return;

				old[0] = (v[0] = v[0] * t + old[0] * u);
				old[1] = (v[1] = v[1] * t + old[1] * u);
				old[2] = (v[2] = v[2] * t + old[2] * u);
			};
		},
		AdaptiveHighPass: function(args) {
			var old = [0, 0, 0],
				result = [0, 0, 0],
				cutoff = 1 / (args && args.cutoff || 0.9),
				constant = cutoff / (1 / (args && args.interval || pi.motionInterval) + cutoff),
				min = args && args.min || 0.033,
				attenuation = args && args.attenuation || 3,
				d,
				alpha;

			return function(v) {
				if (v[0] === null) return;

				d = Math.max(0, Math.min(1, Math.abs(vectorMagnitude(filter) - vectorMagnitude(v)) / min - 1));
				alpha = d * constant / attenuation + (1 - d) * constant;

				result[0] = alpha * (result[0] + v[0] - old[0]);
				result[1] = alpha * (result[1] + v[1] - old[1]);
				result[2] = alpha * (result[2] + v[2] - old[2]);

				old[0] = v[0];
				old[1] = v[1];
				old[2] = v[2];

				v[0] = result[0];
				v[1] = result[1];
				v[2] = result[2];
			};
		},
		Inertia: function(dampening) {
			var old = [0, 0, 0],
				damp = 1 - dampening,
				d;

			// this filter naively dampens the components of a vector if the
			// sign of their delta differs from the sign of the value itself

			return function(v) {
				if (v[0] === null) return;

				d = v[0] - old[0];
				if (d < 0 !== v[0] < 0) v[0] -= d * damp;

				d = v[1] - old[1];
				if (d < 0 !== v[1] < 0) v[1] -= d * damp;

				d = v[2] - old[2];
				if (d < 0 !== v[2] < 0) v[2] -= d * damp;
			};
		},
		MovingAverage: function(length) {
			// default length assumes a delay of .5 seconds
			// results of symmetric filters like this have a delay of (length - 1) / 2 iterations
			var stored = [],
				mean = [0, 0, 0],
				maxLength = length || (1000 / pi.motionInterval + 1),
				cur,
				l,
				i;

			return function(v) {
				if (v[0] === null) return;

				stored.push(v.slice());
				if (stored.length > maxLength) stored.shift();

				mean[0] = mean[1] = mean[2] = 0;

				for (i = 0; cur = stored[i]; ++i) {
					mean[0] += cur[0];
					mean[1] += cur[1];
					mean[2] += cur[2];
				}

				l = stored.length;

				v[0] = mean[0] / l;
				v[1] = mean[1] / l;
				v[2] = mean[2] / l;
			};
		}
	}
};

// default values for new objects
var defaults = {
	pollRate: 50,
	autoPoll: true,
	dispatcherEnabled: true,
	controlEnabled: true,
	
	allowContextMenu: false,
	allowMiddleMouseScroll: false,
	allowSelect: false,
	allowDrag: false,
	allowFocusOnHover: true,
	allowDefaultKeyboardEvents: false,
	
	analogDeadZone: .1,
	analogThreshold: .01,
	analogNormalized: true,
	
	deviceEnabled: true,
	devicePollRate: 33,
	deviceDeadZone: 0,
	deviceThreshold: 0,
	deviceCapture: false,
	deviceNormalized: true,
	deviceComponentNormalized: true,
	
	touchAreaEnabled: true,
	touchDeadZone: .1,
	touchThreshold: .01,
	touchSnap: true,
	touchFloatOrigin: true,
	touchAllowScrolling: false,
	touchNormalized: true,

	orientationXYThreshold: 0.01,
	orientationXYDeadZone: 0.1,
	orientationXYNormalized: false,
	orientationZThreshold: 0.02,
	orientationZDeadZone: 0.5,
	orientationZNormalized: false,

	accelerationThreshold: 0.01,
	accelerationDeadZone: 0.01,
	accelerationFilter: false,

	accelerationIncludingGravityThreshold: 0.01,
	accelerationIncludingGravityDeadZone: 0,
	accelerationIncludingGravityFilter: false,

	rotationThreshold: 0.25,
	rotationDeadZone: 1.0,
	rotationFilter: false,

	velocityThreshold: 0.001,
	velocityDeadZone: 0.01,
	velocityFilter: false,

	positionThreshold: 0.01,
	positionDeadZone: 0.0,
	positionFilter: false
};

// defaults we can't init right away

function initMotionDefaults(e) {
	pi.motionInterval = e.interval;

	defaults.accelerationFilter = [new pi.Filter.MovingAverage()];
	defaults.accelerationIncludingGravityFilter = [new pi.Filter.MovingAverage(21)];
	defaults.rotationFilter = new pi.Filter.MovingAverage();
	defaults.velocityFilter = [new pi.Filter.MovingAverage(), new pi.Filter.MovingAverage()];
	defaults.positionFilter = new pi.Filter.MovingAverage();

	window.removeEventListener('devicemotion', initMotionDefaults);
}

window.addEventListener('devicemotion', initMotionDefaults);

// input devices and components
var components = {
	// events

	PRESS: "Press",
	RELEASE: "Release",
	HOLD: "Hold",
	MOVE: "Move",

	//devices

	KEYBOARD: "Keyboard",
	MOUSE: "Mouse",
	GAMEPAD: "Gamepad",
	GAMEPAD_0: "Gamepad 0",
	GAMEPAD_1: "Gamepad 1",
	GAMEPAD_2: "Gamepad 2",
	GAMEPAD_3: "Gamepad 3",
	MOTION: "Motion",
	
	// gamepad components

	GAMEPAD_LEFT_STICK_X: "Left Stick X",
	GAMEPAD_LEFT_STICK_Y: "Left Stick Y",
	GAMEPAD_RIGHT_STICK_X: "Right Stick X",
	GAMEPAD_RIGHT_STICK_Y: "Right Stick Y",
	GAMEPAD_BUTTON_0: "Button 0",
	GAMEPAD_BUTTON_1: "Button 1",
	GAMEPAD_BUTTON_2: "Button 2",
	GAMEPAD_BUTTON_3: "Button 3",
	GAMEPAD_LEFT_SHOULDER: "Left Shoulder",
	GAMEPAD_RIGHT_SHOULDER: "Right Shoulder",
	GAMEPAD_LEFT_TRIGGER: "Left Trigger",
	GAMEPAD_RIGHT_TRIGGER: "Right Trigger",
	GAMEPAD_SELECT: "Select",
	GAMEPAD_START: "Start",
	GAMEPAD_LEFT_STICK_BUTTON: "Left Stick Button",
	GAMEPAD_RIGHT_STICK_BUTTON: "Right Stick Button",
	GAMEPAD_DPAD_UP: "DPad Up",
	GAMEPAD_DPAD_DOWN: "DPad Down",
	GAMEPAD_DPAD_LEFT: "DPad Left",
	GAMEPAD_DPAD_RIGHT: "DPad Right",
	GAMEPAD_BUTTON_16: "Button 16",
	GAMEPAD_BUTTON_17: "Button 17",
	GAMEPAD_BUTTON_18: "Button 18",
	GAMEPAD_BUTTON_19: "Button 19",
	GAMEPAD_BUTTON_20: "Button 20",
	GAMEPAD_BUTTON_21: "Button 21",
	GAMEPAD_BUTTON_22: "Button 22",
	GAMEPAD_BUTTON_23: "Button 23",
	GAMEPAD_BUTTON_24: "Button 24",
	GAMEPAD_BUTTON_25: "Button 25",
	GAMEPAD_BUTTON_26: "Button 26",
	GAMEPAD_BUTTON_27: "Button 27",
	GAMEPAD_BUTTON_28: "Button 28",
	GAMEPAD_BUTTON_29: "Button 29",
	GAMEPAD_BUTTON_30: "Button 30",
	GAMEPAD_BUTTON_31: "Button 31",

	GAMEPAD_LEFT_STICK_RADIAL_X: "Left Stick Radial X",
	GAMEPAD_LEFT_STICK_RADIAL_Y: "Left Stick Radial Y",
	GAMEPAD_RIGHT_STICK_RADIAL_X: "Right Stick Radial X",
	GAMEPAD_RIGHT_STICK_RADIAL_Y: "Right Stick Radial Y",

	// orientation & motion

	MOTION_ORIENTATION_X: "Orientation X",
	MOTION_ORIENTATION_Y: "Orientation Y",
	MOTION_ORIENTATION_Z: "Orientation Z",
	MOTION_ORIENTATION_MAGNITUDE: "Orientation Magnitude",

	MOTION_ACCELERATION_X: "Acceleration X",
	MOTION_ACCELERATION_Y: "Acceleration Y",
	MOTION_ACCELERATION_Z: "Acceleration Z",
	MOTION_ACCELERATION_MAGNITUDE: "Acceleration Magnitude",

	MOTION_ACCELERATION_WITH_GRAVITY_X: "Acceleration with Gravity X",
	MOTION_ACCELERATION_WITH_GRAVITY_Y: "Acceleration with Gravity Y",
	MOTION_ACCELERATION_WITH_GRAVITY_Z: "Acceleration with Gravity Z",
	MOTION_ACCELERATION_WITH_GRAVITY_MAGNITUDE: "Acceleration with Gravity Magnitude",

	MOTION_ROTATION_X: "Rotational Speed X",
	MOTION_ROTATION_Y: "Rotational Speed Y",
	MOTION_ROTATION_Z: "Rotational Speed Z",
	MOTION_ROTATION_MAGNITUDE: "Rotational Speed Magnitude",

	// derived motion

	MOTION_VELOCITY_X: "Velocity X",
	MOTION_VELOCITY_Y: "Velocity Y",
	MOTION_VELOCITY_Z: "Velocity Z",
	MOTION_VELOCITY_MAGNITUDE: "Velocity Magnitude",

	MOTION_POSITION_X: "Position X",
	MOTION_POSITION_Y: "Position Y",
	MOTION_POSITION_Z: "Position Z",
	MOTION_POSITION_MAGNITUDE: "Position Magnitude",

	// mouse

	MOUSE_MOVE: "Mouse Move",
	MOUSE_LEFT_BUTTON: "Left Mouse Button",
	MOUSE_RIGHT_BUTTON: "Right Mouse Button",
	MOUSE_MIDDLE_BUTTON: "Middle Mouse Button",
	MOUSE_SCROLL_UP: "Mouse Scroll Up",
	MOUSE_SCROLL_DOWN: "Mouse Scroll Down",

	// keyboard

	KEY_BACKSPACE: "Backspace",
	KEY_TAB: "Tab",
	KEY_ENTER: "Enter",
	KEY_SHIFT: "Shift",
	KEY_CTRL: "Ctrl",
	KEY_ALT: "Alt",
	KEY_PAUSE: "Pause/Break",
	KEY_CAPSLOCK: "Caps Lock",
	KEY_ESC: "Esc",
	KEY_SPACE: "Space",
	KEY_PAGEUP: "Page Up",
	KEY_PAGEDOWN: "Page Down",
	KEY_END: "End",
	KEY_HOME: "Home",
	KEY_LEFT: "Left Arrow",
	KEY_UP: "Up Arrow",
	KEY_RIGHT: "Right Arrow",
	KEY_DOWN: "Down Arrow",
	KEY_INSERT: "Insert",
	KEY_DELETE: "Delete",
	KEY_0: "0",
	KEY_1: "1",
	KEY_2: "2",
	KEY_3: "3",
	KEY_4: "4",
	KEY_5: "5",
	KEY_6: "6",
	KEY_7: "7",
	KEY_8: "8",
	KEY_9: "9",
	KEY_A: "A",
	KEY_B: "B",
	KEY_C: "C",
	KEY_D: "D",
	KEY_E: "E",
	KEY_F: "F",
	KEY_G: "G",
	KEY_H: "H",
	KEY_I: "I",
	KEY_J: "J",
	KEY_K: "K",
	KEY_L: "L",
	KEY_M: "M",
	KEY_N: "N",
	KEY_O: "O",
	KEY_P: "P",
	KEY_Q: "Q",
	KEY_R: "R",
	KEY_S: "S",
	KEY_T: "T",
	KEY_U: "U",
	KEY_V: "V",
	KEY_W: "W",
	KEY_X: "X",
	KEY_Y: "Y",
	KEY_Z: "Z",
	KEY_NUMPAD_0: "Numpad 0",
	KEY_NUMPAD_1: "Numpad 1",
	KEY_NUMPAD_2: "Numpad 2",
	KEY_NUMPAD_3: "Numpad 3",
	KEY_NUMPAD_4: "Numpad 4",
	KEY_NUMPAD_5: "Numpad 5",
	KEY_NUMPAD_6: "Numpad 6",
	KEY_NUMPAD_7: "Numpad 7",
	KEY_NUMPAD_8: "Numpad 8",
	KEY_NUMPAD_9: "Numpad 9",
	KEY_NUMPAD_MUL: "Numpad *",
	KEY_NUMPAD_ADD: "Numpad +",
	KEY_NUMPAD_SUB: "Numpad -",
	KEY_NUMPAD_POINT: "Numpad .",
	KEY_NUMPAD_DIV: "Numpad /",
	KEY_SEMICOLON: ";",
	KEY_EQUALS: "=",
	KEY_MINUS: "-"
};


// individual gamepad components
for (var i = 0, l = 4; i < l; ++i) {
	var gamepadCode = "GAMEPAD_" + i;
	components[gamepadCode + "_LEFT_STICK_X"] = components[gamepadCode] + " " + components.GAMEPAD_LEFT_STICK_X;
	components[gamepadCode + "_LEFT_STICK_Y"] = components[gamepadCode] + " " + components.GAMEPAD_LEFT_STICK_Y;
	components[gamepadCode + "_RIGHT_STICK_X"] = components[gamepadCode] + " " + components.GAMEPAD_RIGHT_STICK_X;
	components[gamepadCode + "_RIGHT_STICK_Y"] = components[gamepadCode] + " " + components.GAMEPAD_RIGHT_STICK_Y;
	components[gamepadCode + "_BUTTON_0"] = components[gamepadCode] + " " + components.GAMEPAD_BUTTON_0;
	components[gamepadCode + "_BUTTON_1"] = components[gamepadCode] + " " + components.GAMEPAD_BUTTON_1;
	components[gamepadCode + "_BUTTON_2"] = components[gamepadCode] + " " + components.GAMEPAD_BUTTON_2;
	components[gamepadCode + "_BUTTON_3"] = components[gamepadCode] + " " + components.GAMEPAD_BUTTON_3;
	components[gamepadCode + "_LEFT_SHOULDER"] = components[gamepadCode] + " " + components.GAMEPAD_LEFT_SHOULDER;
	components[gamepadCode + "_RIGHT_SHOULDER"] = components[gamepadCode] + " " + components.GAMEPAD_RIGHT_SHOULDER;
	components[gamepadCode + "_LEFT_TRIGGER"] = components[gamepadCode] + " " + components.GAMEPAD_LEFT_TRIGGER;
	components[gamepadCode + "_RIGHT_TRIGGER"] = components[gamepadCode] + " " + components.GAMEPAD_RIGHT_TRIGGER;
	components[gamepadCode + "_SELECT"] = components[gamepadCode] + " " + components.GAMEPAD_SELECT;
	components[gamepadCode + "_START"] = components[gamepadCode] + " " + components.GAMEPAD_START;
	components[gamepadCode + "_LEFT_STICK_BUTTON"] = components[gamepadCode] + " " + components.GAMEPAD_LEFT_STICK_BUTTON;
	components[gamepadCode + "_RIGHT_STICK_BUTTON"] = components[gamepadCode] + " " + components.GAMEPAD_RIGHT_STICK_BUTTON;
	components[gamepadCode + "_DPAD_UP"] = components[gamepadCode] + " " + components.GAMEPAD_DPAD_UP;
	components[gamepadCode + "_DPAD_DOWN"] = components[gamepadCode] + " " + components.GAMEPAD_DPAD_DOWN;
	components[gamepadCode + "_DPAD_LEFT"] = components[gamepadCode] + " " + components.GAMEPAD_DPAD_LEFT;
	components[gamepadCode + "_DPAD_RIGHT"] = components[gamepadCode] + " " + components.GAMEPAD_DPAD_RIGHT;
	components[gamepadCode + "_BUTTON_16"] = components[gamepadCode] + " " + components.GAMEPAD_BUTTON_16;
	components[gamepadCode + "_BUTTON_17"] = components[gamepadCode] + " " + components.GAMEPAD_BUTTON_17;
	components[gamepadCode + "_BUTTON_18"] = components[gamepadCode] + " " + components.GAMEPAD_BUTTON_18;
	components[gamepadCode + "_BUTTON_19"] = components[gamepadCode] + " " + components.GAMEPAD_BUTTON_19;
	components[gamepadCode + "_BUTTON_20"] = components[gamepadCode] + " " + components.GAMEPAD_BUTTON_20;
	components[gamepadCode + "_BUTTON_21"] = components[gamepadCode] + " " + components.GAMEPAD_BUTTON_21;
	components[gamepadCode + "_BUTTON_22"] = components[gamepadCode] + " " + components.GAMEPAD_BUTTON_22;
	components[gamepadCode + "_BUTTON_23"] = components[gamepadCode] + " " + components.GAMEPAD_BUTTON_23;
	components[gamepadCode + "_BUTTON_24"] = components[gamepadCode] + " " + components.GAMEPAD_BUTTON_24;
	components[gamepadCode + "_BUTTON_25"] = components[gamepadCode] + " " + components.GAMEPAD_BUTTON_25;
	components[gamepadCode + "_BUTTON_26"] = components[gamepadCode] + " " + components.GAMEPAD_BUTTON_26;
	components[gamepadCode + "_BUTTON_27"] = components[gamepadCode] + " " + components.GAMEPAD_BUTTON_27;
	components[gamepadCode + "_BUTTON_28"] = components[gamepadCode] + " " + components.GAMEPAD_BUTTON_28;
	components[gamepadCode + "_BUTTON_29"] = components[gamepadCode] + " " + components.GAMEPAD_BUTTON_29;
	components[gamepadCode + "_BUTTON_30"] = components[gamepadCode] + " " + components.GAMEPAD_BUTTON_30;
	components[gamepadCode + "_BUTTON_31"] = components[gamepadCode] + " " + components.GAMEPAD_BUTTON_31;

	components[gamepadCode + "_LEFT_STICK_RADIAL_X"] = components[gamepadCode] + " " + components.GAMEPAD_LEFT_STICK_RADIAL_X;
	components[gamepadCode + "_LEFT_STICK_RADIAL_Y"] = components[gamepadCode] + " " + components.GAMEPAD_LEFT_STICK_RADIAL_Y;
	components[gamepadCode + "_RIGHT_STICK_RADIAL_X"] = components[gamepadCode] + " " + components.GAMEPAD_RIGHT_STICK_RADIAL_X;
	components[gamepadCode + "_RIGHT_STICK_RADIAL_Y"] = components[gamepadCode] + " " + components.GAMEPAD_RIGHT_STICK_RADIAL_Y;
}

var componentToDevice = {};

// copy them into the public interface
for (var code in components) {
	pi[code] = components[code];
	var splitCode = code.split("_");

	switch(splitCode[0]) {
		case "KEYBOARD":
		case "KEY":
			componentToDevice[pi[code]] = pi.KEYBOARD;
			break;
		case "MOUSE":
			componentToDevice[pi[code]] = pi.MOUSE;
			break;
		case "GAMEPAD":
			componentToDevice[pi[code]] = pi.GAMEPAD;
			if (splitCode.length > 1 && splitCode[1].match(/[^\d]/g) === null) componentToDevice[pi[code]] += " " + splitCode[1];
			break;
		case "MOTION":
			componentToDevice[pi[code]] = pi.MOTION;
			break;
	}
}

// DOM callback properties
// keyboard
var keyCodeToComponent = [];
keyCodeToComponent[8] = pi.KEY_BACKSPACE;
keyCodeToComponent[9] = pi.KEY_TAB;
keyCodeToComponent[13] = pi.KEY_ENTER;
keyCodeToComponent[16] = pi.KEY_SHIFT;
keyCodeToComponent[17] = pi.KEY_CTRL;
keyCodeToComponent[18] = pi.KEY_ALT;
keyCodeToComponent[19] = pi.KEY_PAUSE;
keyCodeToComponent[20] = pi.KEY_CAPSLOCK;
keyCodeToComponent[27] = pi.KEY_ESC;
keyCodeToComponent[32] = pi.KEY_SPACE;
keyCodeToComponent[33] = pi.KEY_PAGEUP;
keyCodeToComponent[34] = pi.KEY_PAGEDOWN;
keyCodeToComponent[35] = pi.KEY_END;
keyCodeToComponent[36] = pi.KEY_HOME;
keyCodeToComponent[37] = pi.KEY_LEFT;
keyCodeToComponent[38] = pi.KEY_UP;
keyCodeToComponent[39] = pi.KEY_RIGHT;
keyCodeToComponent[40] = pi.KEY_DOWN;
keyCodeToComponent[45] = pi.KEY_INSERT;
keyCodeToComponent[46] = pi.KEY_DELETE;
keyCodeToComponent[48] = pi.KEY_0;
keyCodeToComponent[49] = pi.KEY_1;
keyCodeToComponent[50] = pi.KEY_2;
keyCodeToComponent[51] = pi.KEY_3;
keyCodeToComponent[52] = pi.KEY_4;
keyCodeToComponent[53] = pi.KEY_5;
keyCodeToComponent[54] = pi.KEY_6;
keyCodeToComponent[55] = pi.KEY_7;
keyCodeToComponent[56] = pi.KEY_8;
keyCodeToComponent[57] = pi.KEY_9;
keyCodeToComponent[65] = pi.KEY_A;
keyCodeToComponent[66] = pi.KEY_B;
keyCodeToComponent[67] = pi.KEY_C;
keyCodeToComponent[68] = pi.KEY_D;
keyCodeToComponent[69] = pi.KEY_E;
keyCodeToComponent[70] = pi.KEY_F;
keyCodeToComponent[71] = pi.KEY_G;
keyCodeToComponent[72] = pi.KEY_H;
keyCodeToComponent[73] = pi.KEY_I;
keyCodeToComponent[74] = pi.KEY_J;
keyCodeToComponent[75] = pi.KEY_K;
keyCodeToComponent[76] = pi.KEY_L;
keyCodeToComponent[77] = pi.KEY_M;
keyCodeToComponent[78] = pi.KEY_N;
keyCodeToComponent[79] = pi.KEY_O;
keyCodeToComponent[80] = pi.KEY_P;
keyCodeToComponent[81] = pi.KEY_Q;
keyCodeToComponent[82] = pi.KEY_R;
keyCodeToComponent[83] = pi.KEY_S;
keyCodeToComponent[84] = pi.KEY_T;
keyCodeToComponent[85] = pi.KEY_U;
keyCodeToComponent[86] = pi.KEY_V;
keyCodeToComponent[87] = pi.KEY_W;
keyCodeToComponent[88] = pi.KEY_X;
keyCodeToComponent[89] = pi.KEY_Y;
keyCodeToComponent[90] = pi.KEY_Z;
keyCodeToComponent[112] = pi.KEY_F1;
keyCodeToComponent[113] = pi.KEY_F2;
keyCodeToComponent[114] = pi.KEY_F3;
keyCodeToComponent[115] = pi.KEY_F4;
keyCodeToComponent[116] = pi.KEY_F5;
keyCodeToComponent[117] = pi.KEY_F6;
keyCodeToComponent[118] = pi.KEY_F7;
keyCodeToComponent[119] = pi.KEY_F8;
keyCodeToComponent[120] = pi.KEY_F9;
keyCodeToComponent[121] = pi.KEY_F10;
keyCodeToComponent[122] = pi.KEY_F11;
keyCodeToComponent[123] = pi.KEY_F12;
keyCodeToComponent[144] = pi.KEY_NUMLOCK;
keyCodeToComponent[145] = pi.KEY_SCOLLLOCK;
keyCodeToComponent[188] = pi.KEY_COMMA;
keyCodeToComponent[190] = pi.KEY_PERIOD;
keyCodeToComponent[191] = pi.KEY_SLASH;
keyCodeToComponent[192] = pi.KEY_GRAVE;
keyCodeToComponent[219] = pi.KEY_BRACKET_OPEN;
keyCodeToComponent[220] = pi.KEY_BACKSLASH;
keyCodeToComponent[221] = pi.KEY_BRACKET_CLOSE;
keyCodeToComponent[222] = pi.KEY_APOSTROPHE;
keyCodeToComponent[96] = pi.KEY_NUMPAD_0;
keyCodeToComponent[97] = pi.KEY_NUMPAD_1;
keyCodeToComponent[98] = pi.KEY_NUMPAD_2;
keyCodeToComponent[99] = pi.KEY_NUMPAD_3;
keyCodeToComponent[100] = pi.KEY_NUMPAD_4;
keyCodeToComponent[101] = pi.KEY_NUMPAD_5;
keyCodeToComponent[102] = pi.KEY_NUMPAD_6;
keyCodeToComponent[103] = pi.KEY_NUMPAD_7;
keyCodeToComponent[104] = pi.KEY_NUMPAD_8;
keyCodeToComponent[105] = pi.KEY_NUMPAD_0;
keyCodeToComponent[106] = pi.KEY_NUMPAD_MUL;
keyCodeToComponent[107] = pi.KEY_NUMPAD_ADD;
keyCodeToComponent[109] = pi.KEY_NUMPAD_SUB;
keyCodeToComponent[110] = pi.KEY_NUMPAD_POINT;
keyCodeToComponent[111] = pi.KEY_NUMPAD_DIV;

// assign browser specific keycodes
switch (UTILS.browserFamily) {
	case "webkit":
	case "ie":
		keyCodeToComponent[186] = pi.KEY_SEMICOLON;
		keyCodeToComponent[187] = pi.KEY_EQUALS;
		keyCodeToComponent[189] = pi.KEY_MINUS;
		break;
	case "mozilla":
		keyCodeToComponent[59] = pi.KEY_SEMICOLON;
		keyCodeToComponent[107] = pi.KEY_EQUALS;
		keyCodeToComponent[109] = pi.KEY_MINUS;
		break;
	case "opera":
		keyCodeToComponent[59] = pi.KEY_SEMICOLON;
		keyCodeToComponent[61] = pi.KEY_EQUALS;
		keyCodeToComponent[109] = pi.KEY_MINUS;
		break;
}

var keyIsPressed = [];

// mouse
var buttonToComponent = [];
buttonToComponent[1] = pi.MOUSE_LEFT_BUTTON;
buttonToComponent[2] = pi.MOUSE_MIDDLE_BUTTON;
buttonToComponent[3] = pi.MOUSE_RIGHT_BUTTON;

// gamepad
var maxPads = 4;
var maxButtons = 32;
var maxAxes = 4;
var getGamepads = UTILS.getMember(navigator, ["getGamepads", "webkitGetGamepads"]);

var gamepadCodes = [
	pi.GAMEPAD_0,
	pi.GAMEPAD_1,
	pi.GAMEPAD_2,
	pi.GAMEPAD_3
];

var axisCodes = [
	pi.GAMEPAD_LEFT_STICK_X,
	pi.GAMEPAD_LEFT_STICK_Y,
	pi.GAMEPAD_RIGHT_STICK_X,
	pi.GAMEPAD_RIGHT_STICK_Y
];

var buttonCodes = [
	pi.GAMEPAD_BUTTON_0,
	pi.GAMEPAD_BUTTON_1,
	pi.GAMEPAD_BUTTON_2,
	pi.GAMEPAD_BUTTON_3,
	pi.GAMEPAD_LEFT_SHOULDER,
	pi.GAMEPAD_RIGHT_SHOULDER,
	pi.GAMEPAD_LEFT_TRIGGER,
	pi.GAMEPAD_RIGHT_TRIGGER,
	pi.GAMEPAD_SELECT,
	pi.GAMEPAD_START,
	pi.GAMEPAD_LEFT_STICK_BUTTON,
	pi.GAMEPAD_RIGHT_STICK_BUTTON,
	pi.GAMEPAD_DPAD_UP,
	pi.GAMEPAD_DPAD_DOWN,
	pi.GAMEPAD_DPAD_LEFT,
	pi.GAMEPAD_DPAD_RIGHT,
	pi.GAMEPAD_BUTTON_16,
	pi.GAMEPAD_BUTTON_17,
	pi.GAMEPAD_BUTTON_18,
	pi.GAMEPAD_BUTTON_19,
	pi.GAMEPAD_BUTTON_20,
	pi.GAMEPAD_BUTTON_21,
	pi.GAMEPAD_BUTTON_22,
	pi.GAMEPAD_BUTTON_23,
	pi.GAMEPAD_BUTTON_24,
	pi.GAMEPAD_BUTTON_25,
	pi.GAMEPAD_BUTTON_26,
	pi.GAMEPAD_BUTTON_27,
	pi.GAMEPAD_BUTTON_28,
	pi.GAMEPAD_BUTTON_29,
	pi.GAMEPAD_BUTTON_30,
	pi.GAMEPAD_BUTTON_31
];

var derivedCodes = [
	pi.GAMEPAD_LEFT_STICK_RADIAL_X,
	pi.GAMEPAD_LEFT_STICK_RADIAL_Y,
	pi.GAMEPAD_RIGHT_STICK_RADIAL_X,
	pi.GAMEPAD_RIGHT_STICK_RADIAL_Y
];

// motion codes

var accelerationCodes = [
	pi.MOTION_ACCELERATION_X,
	pi.MOTION_ACCELERATION_Y,
	pi.MOTION_ACCELERATION_Z,
	pi.MOTION_ACCELERATION_MAGNITUDE
];

var accelerationIncludingGravityCodes = [
	pi.MOTION_ACCELERATION_WITH_GRAVITY_X,
	pi.MOTION_ACCELERATION_WITH_GRAVITY_Y,
	pi.MOTION_ACCELERATION_WITH_GRAVITY_Z,
	pi.MOTION_ACCELERATION_WITH_GRAVITY_MAGNITUDE
];

var rotationRateCodes = [
	pi.MOTION_ROTATION_X,
	pi.MOTION_ROTATION_Y,
	pi.MOTION_ROTATION_Z,
	pi.MOTION_ROTATION_MAGNITUDE
];

// derived motion codes

var velocityCodes = [
	pi.MOTION_VELOCITY_X,
	pi.MOTION_VELOCITY_Y,
	pi.MOTION_VELOCITY_Z,
	pi.MOTION_VELOCITY_MAGNITUDE
];

var positionCodes = [
	pi.MOTION_POSITION_X,
	pi.MOTION_POSITION_Y,
	pi.MOTION_POSITION_Z,
	pi.MOTION_POSITION_MAGNITUDE
];

return pi;
})();
