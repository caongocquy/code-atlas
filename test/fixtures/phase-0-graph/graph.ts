import { importedTarget as imported, Service, Parent as Base } from "./target.js";

function localTarget() {}

function localCaller() {
  localTarget();
  imported();
}

class Receiver {
  service: Service;

  constructor(public readonly serviceProperty: Service) {}

  callThis() {
    this.helper();
  }

  helper() {}

  callField() {
    this.service.method();
  }

  callParameterProperty() {
    this.serviceProperty.method();
  }
}

function typedCaller(service: Service) {
  service.method();
}

function newCaller() {
  const service = new Service();
  service.method();
}

function directNewCaller() {
  new Service().method();
}

class LocalParent {}

class LocalChild extends LocalParent {}

class ImportedChild extends Base {}

class OuterA {
  run() {
    function duplicate() {}
    duplicate();
  }
}

class OuterB {
  run() {
    function duplicate() {}
    duplicate();
  }
}
