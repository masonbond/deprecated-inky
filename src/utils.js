;var UTILS = {version:"utils.js 0.0 uber alpha"};

// type deduction
UTILS.isArray = function(a) {
	return Object.prototype.toString.call(a) === "[object Array]";
};

// member detection
UTILS.getMember = function(obj, members) {
	for (var i = 0, l = members.length; i < l; ++i) {
		if (obj[members[i]] !== undefined) return members[i];
	}
	return undefined;
}

// event shortcuts
UTILS.killEvent = function(e) {
	if (e.stopPropagation) e.stopPropagation();
	e.preventDefault();
	e.cancelBubble = true;
	return false;
};

// browser detection
UTILS.browserFamily = (navigator.userAgent.indexOf("MSIE") !== -1 || navigator.userAgent.indexOf("Trident") !== -1) && "ie"
	|| (navigator.userAgent.indexOf("Chrome") !== -1 || navigator.userAgent.indexOf("Safari") !== -1) && "webkit"
	|| navigator.userAgent.indexOf("Opera") !== -1 && "opera"
	|| navigator.userAgent.indexOf("Firefox") !== -1 && "mozilla" || "unknown";

// timer
UTILS.Timer = {startTime:0};

UTILS.Timer.now = (function() {
	var now = (typeof performance !== 'undefined') && (
		performance.now
		|| performance.webkitNow
		|| performance.msNow
		|| performance.mozNow
		|| performance.oNow
	);

	now = (now && now.bind(performance)) || (now = new Date()).getTime.bind(now);

	return function() { return now() - UTILS.Timer.startTime; };
})();

UTILS.Timer.startTime = UTILS.Timer.now();
