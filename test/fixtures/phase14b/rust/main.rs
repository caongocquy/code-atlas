mod inner {
    pub struct Thing {
        value: i32,
    }
}

use crate::inner::Thing as Alias;

enum State {
    Ready,
    Done(i32),
}

trait Render {
    fn render(&self);
}

impl Thing {
    fn new(value: i32) -> Self {
        Self { value }
    }

    fn get(&self) -> i32 {
        self.value
    }
}

impl Render for Thing {
    fn render(&self) {
        println!("render");
    }
}

fn generic<T: Render>(value: T) {
    value.render();
}

fn main() {
    let item = Alias::new(1);
    let value = item.get();
    generic(item);
    let _state = State::Done(value);
}
