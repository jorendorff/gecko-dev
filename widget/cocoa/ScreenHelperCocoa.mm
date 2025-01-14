/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "ScreenHelperCocoa.h"

#import <Cocoa/Cocoa.h>

#include "mozilla/Logging.h"
#include "nsCocoaUtils.h"
#include "nsObjCExceptions.h"

static LazyLogModule sScreenLog("WidgetScreen");

@interface ScreenHelperDelegate : NSObject
{
  @private
    mozilla::widget::ScreenHelperCocoa* mHelper;
}

- (id)initWithScreenHelper:(mozilla::widget::ScreenHelperCocoa*)aScreenHelper;
- (void)didChangeScreenParameters:(NSNotification*)aNotification;
@end

@implementation ScreenHelperDelegate
- (id)initWithScreenHelper:(mozilla::widget::ScreenHelperCocoa*)aScreenHelper
{
  if ((self = [self init])) {
    mHelper = aScreenHelper;

    [[NSNotificationCenter defaultCenter] addObserver:self
                                             selector:@selector(didChangeScreenParameters:)
                                                 name:NSApplicationDidChangeScreenParametersNotification
                                               object:nil];
  }

  return self;
}

- (void)dealloc
{
  [[NSNotificationCenter defaultCenter] removeObserver:self];
  [super dealloc];
}

- (void)didChangeScreenParameters:(NSNotification*)aNotification
{
  MOZ_LOG(sScreenLog, LogLevel::Debug,
          ("Received NSApplicationDidChangeScreenParametersNotification"));

  mHelper->RefreshScreens();
}
@end

namespace mozilla {
namespace widget {

ScreenHelperCocoa::ScreenHelperCocoa()
{
  NS_OBJC_BEGIN_TRY_ABORT_BLOCK;

  MOZ_LOG(sScreenLog, LogLevel::Debug, ("ScreenHelperCocoa created"));

  mDelegate = [[ScreenHelperDelegate alloc] initWithScreenHelper:this];

  RefreshScreens();

  NS_OBJC_END_TRY_ABORT_BLOCK;
}

ScreenHelperCocoa::~ScreenHelperCocoa()
{
  NS_OBJC_BEGIN_TRY_ABORT_BLOCK;

  [mDelegate release];

  NS_OBJC_END_TRY_ABORT_BLOCK;
}

static already_AddRefed<Screen>
MakeScreen(NSScreen* aScreen)
{
  NS_OBJC_BEGIN_TRY_ABORT_BLOCK_RETURN;

  DesktopToLayoutDeviceScale contentsScaleFactor(nsCocoaUtils::GetBackingScaleFactor(aScreen));
  CSSToLayoutDeviceScale defaultCssScaleFactor(contentsScaleFactor.scale);
  NSRect frame = [aScreen frame];
  LayoutDeviceIntRect rect =
    nsCocoaUtils::CocoaRectToGeckoRectDevPix(frame, contentsScaleFactor.scale);
  frame = [aScreen visibleFrame];
  LayoutDeviceIntRect availRect =
    nsCocoaUtils::CocoaRectToGeckoRectDevPix(frame, contentsScaleFactor.scale);
  NSWindowDepth depth = [aScreen depth];
  uint32_t pixelDepth = NSBitsPerPixelFromDepth(depth);

  MOZ_LOG(sScreenLog, LogLevel::Debug, ("New screen [%d %d %d %d %d %f]",
                                        rect.x, rect.y, rect.width, rect.height,
                                        pixelDepth, contentsScaleFactor.scale));

  RefPtr<Screen> screen = new Screen(rect, availRect,
                                     pixelDepth, pixelDepth,
                                     contentsScaleFactor, defaultCssScaleFactor);
  return screen.forget();

  NS_OBJC_END_TRY_ABORT_BLOCK_RETURN(nullptr);
}

float
ScreenHelperCocoa::GetSystemDefaultScale()
{
  return 1.0f;
}

void
ScreenHelperCocoa::RefreshScreens()
{
  NS_OBJC_BEGIN_TRY_ABORT_BLOCK;

  MOZ_LOG(sScreenLog, LogLevel::Debug, ("Refreshing screens"));

  AutoTArray<RefPtr<Screen>, 4> screens;

  for (NSScreen* screen in [NSScreen screens]) {
    NSDictionary *desc = [screen deviceDescription];
    if ([desc objectForKey:NSDeviceIsScreen] == nil) {
      continue;
    }
    screens.AppendElement(MakeScreen(screen));
  }

  ScreenManager& screenManager = ScreenManager::GetSingleton();
  screenManager.Refresh(Move(screens));

  NS_OBJC_END_TRY_ABORT_BLOCK;
}

NSScreen*
ScreenHelperCocoa::CocoaScreenForScreen(nsIScreen* aScreen)
{
  NS_OBJC_BEGIN_TRY_ABORT_BLOCK_NIL;

  for (NSScreen* screen in [NSScreen screens]) {
    NSDictionary *desc = [screen deviceDescription];
    if ([desc objectForKey:NSDeviceIsScreen] == nil) {
      continue;
    }
    LayoutDeviceIntRect rect;
    double scale;
    aScreen->GetRect(&rect.x, &rect.y, &rect.width, &rect.height);
    aScreen->GetContentsScaleFactor(&scale);
    NSRect frame = [screen frame];
    LayoutDeviceIntRect frameRect =
      nsCocoaUtils::CocoaRectToGeckoRectDevPix(frame, scale);
    if (rect == frameRect) {
      return screen;
    }
  }
  return [NSScreen mainScreen];

  NS_OBJC_END_TRY_ABORT_BLOCK_NIL;
}

} // namespace widget
} // namespace mozilla
